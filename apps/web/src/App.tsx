import { useEffect, useState } from 'react';
import { Route, Routes } from 'react-router';

import { createIsagiClient } from './client.js';
import { resolveRuntimeUrl } from './runtime.js';

type RuntimeState =
  | { status: 'checking' }
  | { message: string; status: 'connected'; url: string }
  | { error: string; status: 'disconnected' };

function HomePage() {
  const [runtimeState, setRuntimeState] = useState<RuntimeState>({
    status: 'checking',
  });

  useEffect(() => {
    let cancelled = false;

    const connect = async () => {
      try {
        const url = await resolveRuntimeUrl();
        const client = createIsagiClient(url);
        const health = await client.health();

        if (!cancelled) {
          setRuntimeState({
            message: `${health.name} v${health.version} responded at ${health.timestamp}`,
            status: 'connected',
            url,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setRuntimeState({
            error: error instanceof Error ? error.message : 'Unknown runtime error',
            status: 'disconnected',
          });
        }
      }
    };

    void connect();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="min-h-screen bg-[#24273a] text-[#cad3f5]">
      <section className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-8 py-16">
        <p className="mb-3 font-mono text-xs tracking-[0.18em] text-[#6e738d] uppercase">
          Isagi spine
        </p>
        <h1 className="text-5xl font-semibold tracking-[-0.04em] text-[#cad3f5]">Isagi</h1>
        <div className="mt-8 rounded-3xl border border-[#5b6078]/50 bg-[#363a4f]/70 p-6 shadow-[0_16px_48px_rgba(0,0,0,0.35)]">
          <p className="text-sm text-[#a5adcb]">Runtime</p>
          <RuntimeStatus state={runtimeState} />
        </div>
      </section>
    </main>
  );
}

function RuntimeStatus({ state }: { state: RuntimeState }) {
  if (state.status === 'checking') {
    return <p className="mt-2 text-lg text-[#f5a97f]">checking...</p>;
  }

  if (state.status === 'disconnected') {
    return <p className="mt-2 text-lg text-[#ed8796]">disconnected: {state.error}</p>;
  }

  return (
    <div className="mt-2 space-y-2">
      <p className="text-lg text-[#a6da95]">connected</p>
      <p className="font-mono text-xs text-[#6e738d]">{state.url}</p>
      <p className="text-sm text-[#a5adcb]">{state.message}</p>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<HomePage />} path="*" />
    </Routes>
  );
}
