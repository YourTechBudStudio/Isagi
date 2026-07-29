import { createContext } from 'react';

import type { TerminalSettings } from '@isagi/contracts';

import type { TerminalPresentationCache } from '../terminal-cache/index.js';
import type { TerminalSessionIdentity } from '../terminal-cache/index.js';
import type { TerminalPresentationController } from './controller.js';
import type { TerminalAttachmentEvent } from './controller.js';
import type { TerminalDiagnosticsCollector } from './diagnostics.js';
import type { TerminalPresentationEnvironment } from './environment.js';

export interface TerminalPresentationWorkspace {
  readonly cache: TerminalPresentationCache<TerminalPresentationController>;
  readonly parkingRoot: HTMLDivElement;
  readonly settings: TerminalSettings;
  readonly diagnostics: TerminalDiagnosticsCollector;
  readonly environment?: TerminalPresentationEnvironment | undefined;
  readonly dispose: () => void;
  readonly start: () => void;
  readonly onAttachmentEvent: (
    identity: TerminalSessionIdentity,
    event: TerminalAttachmentEvent,
  ) => void;
}

export const TerminalPresentationContext = createContext<TerminalPresentationWorkspace | null>(
  null,
);
