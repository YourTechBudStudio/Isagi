import type { ReactNode } from 'react';

import type { TerminalBodyKind } from './terminalCacheFixtures.js';

/**
 * Development-only. Static, ANSI-flavoured terminal content: plain spans on the
 * terminal surface in xterm's own metrics (12px / 1.35), so the gallery needs no
 * real renderer, socket, or session. None of this text is production copy.
 */
export function MockTerminalBody({ kind }: { readonly kind: TerminalBodyKind }) {
  if (kind === 'blank') {
    return <div className="h-full bg-terminal-surface" />;
  }
  const rows = kind === 'tui' ? TUI_ROWS : kind === 'trimmed' ? TRIMMED_ROWS : TRANSCRIPT_ROWS;

  return (
    <div className="h-full overflow-hidden bg-terminal-surface px-1 py-0.5 font-mono text-[12px] leading-[1.35] whitespace-pre text-fg">
      {rows.map((row, index) => (
        <div key={`row-${index}`}>{row}</div>
      ))}
    </div>
  );
}

const prompt = <span className="text-green">$ </span>;
const dim = (text: string) => <span className="text-fg-subtle">{text}</span>;
const ok = (text: string) => <span className="text-green">{text}</span>;
const cursor = <span className="bg-cyan text-terminal-surface"> </span>;
const blank = <> </>;

const TRANSCRIPT_ROWS: readonly ReactNode[] = [
  <>{prompt}pnpm --filter @isagi/runtime test</>,
  <>
    {dim('› ')}runtime {ok('148 passed')} {dim('2 skipped')} {dim('4.21s')}
  </>,
  <>
    {dim('› ')}workflows {ok('36 passed')} {dim('1.08s')}
  </>,
  blank,
  <>
    <span className="text-violet">●</span> Reading{' '}
    {dim('docs/adrs/0006-durable-worktree-environment-entities.md')}
  </>,
  <>
    <span className="text-violet">●</span> Editing{' '}
    {dim('apps/runtime/src/agent-sessions/harness/registry.ts')}
  </>,
  <>{dim('  ~ 18 lines changed')}</>,
  blank,
  <>{prompt}git status --short</>,
  <>
    <span className="text-amber"> M</span> apps/runtime/src/agent-sessions/harness/registry.ts
  </>,
  <>
    <span className="text-red">??</span> scratch/plans/terminal-presentation-cache/
  </>,
  blank,
  <>
    {prompt}
    {cursor}
  </>,
];

/** Opens mid-output: the oldest row Isagi still holds, with no leading context. */
const TRIMMED_ROWS: readonly ReactNode[] = [
  <>{dim('  at Object.<anonymous> (apps/runtime/src/workflows/loader.ts:184:11)')}</>,
  <>{dim('  at async Promise.all (index 3)')}</>,
  blank,
  <>{prompt}pnpm --filter @isagi/runtime check</>,
  <>
    {dim('› ')}typecheck {ok('ok')} {dim('6.02s')}
  </>,
  <>
    {dim('› ')}build {ok('ok')} {dim('3.47s')}
  </>,
  blank,
  <>
    {prompt}
    {cursor}
  </>,
];

const TUI_ROWS: readonly ReactNode[] = [
  <>{dim('┌─ isagi ─────────────────────────────────────────────────┐')}</>,
  <>
    {dim('│ ')}
    <span className="text-blue">worktree</span> feat/terminal-cache
    {dim('                         │')}
  </>,
  <>
    {dim('│ ')}
    <span className="text-violet">status</span> 3 surfaces · 5 panes · 2 agents
    {dim('           │')}
  </>,
  <>{dim('├─────────────────────────────────────────────────────────┤')}</>,
  <>
    {dim('│ ')}
    <span className="text-cyan">▸</span> cold replay barrier{dim('                             │')}
  </>,
  <>{dim('│   viewport restoration                                  │')}</>,
  <>{dim('│   eviction sweep                                        │')}</>,
  <>{dim('└─────────────────────────────────────────────────────────┘')}</>,
  <>{dim(' j/k move · enter open · q quit')}</>,
];
