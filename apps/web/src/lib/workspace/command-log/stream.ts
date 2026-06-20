import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Schema } from 'effect';
import { useCallback, useEffect, useState } from 'react';

import {
  commandLogStreamOutputMessageSchema,
  type CommandLogMetadataLatestRun,
  type CommandLogStreamOutputMessage,
  type CommandStatus,
} from '@isagi/contracts';

import { workbenchCopy } from '../../../copy/index.js';
import {
  type PtyStreamConnectionState,
  type PtyStreamTransport,
  type PtyStreamTransportController,
  usePtyStream,
} from '../pty-stream/index.js';
import { commandLogMetadataQueryKey, worktreeCommandsQueryKey } from '../query-keys.js';
import { formatRuntimeError, resolveCommandLogStreamWebSocketUrl } from '../runtime-data.js';

export type CommandLogStreamState = {
  readonly connection: PtyStreamConnectionState;
  readonly status: CommandStatus | null;
  readonly latestRun: CommandLogMetadataLatestRun | null;
  readonly live: boolean;
  readonly exit: { readonly exitCode: number | null; readonly signal: string | null } | null;
};

export function useCommandLogStream({
  worktreeId,
  commandName,
  latestRunId,
}: {
  readonly worktreeId: number;
  readonly commandName: string;
  readonly latestRunId: number;
}): {
  readonly transport: PtyStreamTransport;
  readonly streamKey: string;
  readonly state: CommandLogStreamState;
  readonly rendererWarning: string | null;
  readonly setRendererWarning: (message: string | null) => void;
} {
  const queryClient = useQueryClient();
  const streamKey = `${worktreeId}:${commandName}:${latestRunId}`;
  const [status, setStatus] = useState<CommandStatus | null>(null);
  const [latestRun, setLatestRun] = useState<CommandLogMetadataLatestRun | null>(null);
  const [live, setLive] = useState(false);
  const [exit, setExit] = useState<CommandLogStreamState['exit']>(null);
  const [rendererWarning, setRendererWarning] = useState<string | null>(null);

  useEffect(() => {
    setStatus(null);
    setLatestRun(null);
    setLive(false);
    setExit(null);
    setRendererWarning(null);
  }, [streamKey]);

  const resolveUrl = useCallback(
    () => resolveCommandLogStreamWebSocketUrl(worktreeId, commandName),
    [commandName, worktreeId],
  );

  const handleDomainMessage = useCallback(
    (message: CommandLogStreamOutputMessage, _transport: PtyStreamTransportController) => {
      if (message.type !== 'command_log_state') {
        return;
      }
      setStatus(message.status);
      setLatestRun(message.latestRun);
      setLive(message.live);
    },
    [],
  );

  const handleExit = useCallback(
    (
      nextExit: { readonly exitCode: number | null; readonly signal: string | null },
      _transport: PtyStreamTransportController,
    ) => {
      setExit(nextExit);
      setLive(false);
      void invalidateCommandReadModel(queryClient, worktreeId, commandName);
    },
    [commandName, queryClient, worktreeId],
  );

  const handleResolveError = useCallback(
    (error: unknown) => ({ message: formatRuntimeError(error) }),
    [],
  );

  const handleSocketError = useCallback(
    () => ({ message: workbenchCopy.commandLogConnectionFailed }),
    [],
  );

  const { transport, connection } = usePtyStream({
    enabled: true,
    resetKey: streamKey,
    connectKey: streamKey,
    initialInteractive: false,
    resolveUrl,
    decodeMessage: decodeCommandLogStreamMessage,
    onDomainMessage: handleDomainMessage,
    onExit: handleExit,
    onResolveError: handleResolveError,
    onSocketError: handleSocketError,
  });

  return {
    transport,
    streamKey,
    state: { connection, status, latestRun, live, exit },
    rendererWarning,
    setRendererWarning,
  };
}

export function decodeCommandLogStreamMessage(data: unknown): CommandLogStreamOutputMessage | null {
  try {
    return Schema.decodeUnknownSync(commandLogStreamOutputMessageSchema)(JSON.parse(String(data)));
  } catch {
    return null;
  }
}

export async function invalidateCommandReadModel(
  queryClient: QueryClient,
  worktreeId: number,
  commandName: string,
) {
  await queryClient.invalidateQueries({
    queryKey: worktreeCommandsQueryKey(worktreeId),
    exact: true,
  });
  await queryClient.invalidateQueries({
    queryKey: commandLogMetadataQueryKey(worktreeId, commandName),
  });
}
