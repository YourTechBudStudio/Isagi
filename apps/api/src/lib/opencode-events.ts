import {
  getOpencodeInstanceByRootPath,
  listOpenTriage,
  setOpencodeSessionStatus,
  touchOpencodeInstance,
} from "./db/opencode.repository";
import { ensureOpencodeInstance, getOpencodeClient } from "./opencode";
import { handleOpencodeGlobalEvent } from "./triage-service";

interface EventEnvelope {
  readonly payload?: unknown;
}

interface EventRunner {
  stop(): void;
}

class OpencodeEventRunner implements EventRunner {
  private readonly abortController = new AbortController();
  private reconcileTimer: NodeJS.Timeout | undefined;

  constructor(private readonly rootPath: string) {}

  async start(): Promise<void> {
    this.startPeriodicReconcile();

    while (!this.abortController.signal.aborted) {
      try {
        const instance = await ensureOpencodeInstance(this.rootPath);
        const client = getOpencodeClient({
          baseUrl: instance.baseUrl,
          rootPath: this.rootPath,
        });
        const events = await client.global.event({
          signal: this.abortController.signal,
        });

        for await (const event of events.stream as AsyncIterable<EventEnvelope>) {
          if (this.abortController.signal.aborted) {
            return;
          }

          if (!event.payload) {
            continue;
          }

          await handleOpencodeGlobalEvent({
            instanceBaseUrl: instance.baseUrl,
            rootPath: this.rootPath,
            payload: event.payload,
          });
          await touchOpencodeInstance(instance.id, new Date());
        }
      } catch (error) {
        if (this.abortController.signal.aborted) {
          return;
        }

        console.error("OpenCode global event stream failed", {
          rootPath: this.rootPath,
          error,
        });
        await new Promise(resolve => {
          setTimeout(resolve, 1000);
        });
      }
    }
  }

  private startPeriodicReconcile(): void {
    this.reconcileTimer = setInterval(() => {
      void this.reconcile().catch(error => {
        console.error("OpenCode reconcile failed", {
          rootPath: this.rootPath,
          error,
        });
      });
    }, 30_000);
  }

  private async reconcile(): Promise<void> {
    const instance = await ensureOpencodeInstance(this.rootPath);
    const client = getOpencodeClient({
      baseUrl: instance.baseUrl,
      rootPath: this.rootPath,
    });
    const triageRows = await listOpenTriage();
    const statusSnapshot = await client.session.status();

    await Promise.all(
      triageRows.map(async row => {
        const statusType = statusSnapshot.data?.[row.opencodeSessionId]?.type;
        if (
          statusType !== "idle" &&
          statusType !== "busy" &&
          statusType !== "retry"
        ) {
          return;
        }

        await setOpencodeSessionStatus({
          opencodeSessionId: row.opencodeSessionId,
          statusType,
          waitingOnUser:
            statusType === "idle" &&
            row.session.lastMessageRole === "assistant",
          statusUpdatedAt: new Date(),
        });
      }),
    );
  }

  stop(): void {
    this.abortController.abort();
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
  }
}

let runner: OpencodeEventRunner | undefined;

export async function startOpencodeGlobalEventLoop(
  rootPath: string,
): Promise<void> {
  if (runner) {
    return;
  }

  const existing = await getOpencodeInstanceByRootPath(rootPath);
  if (!existing) {
    await ensureOpencodeInstance(rootPath);
  }

  runner = new OpencodeEventRunner(rootPath);
  void runner.start();
}

export async function stopOpencodeGlobalEventLoop(): Promise<void> {
  if (!runner) {
    return;
  }

  runner.stop();
  runner = undefined;
}
