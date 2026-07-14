// TEMPORARY — Phase 03 development-only fixture. Removed in Phase 04 together with
// the `?boot-fixture` branch in `main.tsx`. It is unreachable in production: the
// only entry point is that DEV-guarded dynamic import, which Vite dead-code-
// eliminates from production builds, so this module (and the marker below) never
// ship. It exists purely to review the terminal runtime-failure surface and to
// confirm that Restart/Quit fire, without any Electron host, IPC, or real relaunch.

import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { RuntimeFailureDiagnostic } from './runtime-failure.js';
import { BootSurface } from './StartupSurfaces.js';

// Unique string used by the Phase 03 production-strip check: it must NOT appear in
// `apps/web/dist` after a production build.
const FIXTURE_MARKER = 'isagi-dev-boot-failure-fixture';

// The representative diagnostics the surface must handle. These fixture labels
// describe the scenario for the reviewer only — they are not part of the permanent
// view contract, which carries no lifecycle stage.
type Variant = { id: string; label: string; diagnostic: RuntimeFailureDiagnostic };

const STARTUP_VARIANT: Variant = {
  id: 'startup',
  label: 'startup failure',
  diagnostic: {
    message:
      "Error: Cannot find module './runtime-index.js'\n" +
      '    at Module._resolveFilename (node:internal/modules/cjs/loader:1145:15)\n' +
      '    at Module._load (node:internal/modules/cjs/loader:986:27)',
  },
};

const VARIANTS: Variant[] = [
  STARTUP_VARIANT,
  { id: 'exit', label: 'runtime exit', diagnostic: { exitCode: 1 } },
  { id: 'signal', label: 'terminating signal', diagnostic: { exitCode: null, signal: 'SIGKILL' } },
  {
    id: 'combined',
    label: 'exit + signal + message',
    diagnostic: { message: 'Fatal: runtime event loop stalled', exitCode: 137, signal: 'SIGKILL' },
  },
  {
    id: 'unbreakable',
    label: 'unbreakable token',
    // One long segment with no slashes, spaces, or punctuation — no browser line-break
    // opportunity — so `pre-wrap` cannot wrap it and `overflow-x-auto` must contain it
    // rather than letting it blow out the column.
    diagnostic: {
      message:
        'Runtime stage fingerprint mismatch: ' +
        'isagifixtureunbreakabletoken0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
    },
  },
  { id: 'unavailable', label: 'unavailable detail', diagnostic: {} },
];

function BootFailureFixture() {
  const [variantId, setVariantId] = useState(STARTUP_VARIANT.id);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const variant = VARIANTS.find((entry) => entry.id === variantId) ?? STARTUP_VARIANT;

  return (
    <>
      <BootSurface
        view={{
          kind: 'runtime_failed',
          diagnostic: variant.diagnostic,
          onRestart: () => setLastAction('restart requested'),
          onQuit: () => setLastAction('quit requested'),
        }}
      />
      <div
        data-fixture-marker={FIXTURE_MARKER}
        className="fixed inset-x-0 top-0 z-100 flex flex-wrap items-center gap-2 border-b border-line/40 bg-canvas/85 px-4 py-2 font-mono text-[11px] text-fg-muted backdrop-blur"
      >
        <span className="text-fg-subtle">boot-failure fixture ·</span>
        {VARIANTS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setVariantId(entry.id)}
            className={`rounded-sm border px-2 py-1 transition-colors ${
              entry.id === variantId
                ? 'border-blue/40 text-fg'
                : 'border-line/30 text-fg-subtle hover:text-fg'
            }`}
          >
            {entry.label}
          </button>
        ))}
        <span className="ml-auto text-fg-subtle">
          {lastAction ? `↳ ${lastAction}` : 'no action yet'}
        </span>
      </div>
    </>
  );
}

export function mountBootFailureFixture(root: Element) {
  createRoot(root).render(
    <StrictMode>
      <BootFailureFixture />
    </StrictMode>,
  );
}
