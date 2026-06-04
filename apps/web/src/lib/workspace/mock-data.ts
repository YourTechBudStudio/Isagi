import type { Project } from './types.js';

/**
 * Placeholder workspace contents for the presentational shell. Replaced by
 * live runtime data once the navigation slice lands. Shaped to exercise what
 * the rail and canvas must handle: multiple projects, every attention state,
 * parked worktrees, multiple agent sessions in one (single) agent surface,
 * non-agent surfaces, and an empty worktree.
 */
export const MOCK_PROJECTS: readonly Project[] = [
  {
    id: 'isagi',
    name: 'isagi',
    glyph: 'I',
    accent: 'blue',
    worktrees: [
      {
        id: 'isagi-main',
        title: 'Main',
        branch: 'main',
        attention: 'idle',
        parked: false,
        activeSurfaceId: null,
        commands: [],
        surfaces: [],
      },
      {
        id: 'isagi-surfaces',
        title: 'Worktree continuity surfaces',
        branch: 'wt/surfaces',
        attention: 'working',
        parked: false,
        activeSurfaceId: 'isagi-surfaces-agents',
        commands: [
          {
            id: 'surfaces-dev',
            label: 'pnpm dev',
            status: 'running',
            attention: 'working',
            ports: [5173, 4000],
            log: [
              '$ pnpm dev',
              'isagi:web  VITE ready in 412 ms',
              'isagi:web  → http://localhost:5173/',
              'isagi:api  listening on http://localhost:4000',
              'isagi:web  hmr update /src/routes/workspace/Canvas.tsx',
            ],
          },
          {
            id: 'surfaces-docs',
            label: 'pnpm docs',
            status: 'running',
            attention: 'working',
            ports: [5174],
            log: ['$ pnpm docs', 'VITE ready → http://localhost:5174/'],
          },
          {
            id: 'surfaces-test',
            label: 'pnpm test',
            status: 'running',
            attention: 'working',
            ports: [],
            log: ['$ pnpm test --watch', '✓ 48 passed', 'watching for changes…'],
          },
          {
            id: 'surfaces-storybook',
            label: 'pnpm storybook',
            status: 'stopped',
            attention: 'idle',
            ports: [],
            log: ['(not started — press run to start)'],
          },
          {
            id: 'surfaces-typecheck',
            label: 'pnpm typecheck',
            status: 'exited',
            attention: 'error',
            ports: [],
            log: [
              '$ pnpm typecheck',
              'src/restore.ts:42 - error TS2345: not assignable to SurfaceRef',
              'Found 1 error.',
              '✗ exited with code 1',
            ],
          },
        ],
        surfaces: [
          {
            id: 'isagi-surfaces-agents',
            kind: 'agent',
            title: 'Agents',
            agentSessions: [
              {
                id: 'h-codex',
                harness: 'codex',
                attention: 'working',
                transcript: [
                  '# codex — editing browser-pane.ts',
                  '● run  pnpm check',
                  '  └ passed in 3.1s',
                  '❯',
                ],
              },
              {
                id: 'h-codex-sub',
                harness: 'codex · sub-agent',
                attention: 'working',
                transcript: [
                  '# spawned to map the surfaces module',
                  '● read  restore.ts',
                  '▌ found 3 call sites…',
                  '❯',
                ],
              },
            ],
          },
          {
            id: 'isagi-surfaces-web',
            kind: 'browser',
            title: 'localhost:5173',
            source: 'http://localhost:5173',
            attention: 'working',
          },
          {
            id: 'isagi-surfaces-code',
            kind: 'editor',
            title: 'code-server',
            source: 'code-server · wt/surfaces',
            attention: 'idle',
          },
          {
            id: 'isagi-surfaces-readme',
            kind: 'artifact',
            title: 'README.md',
            source: 'README.md',
          },
          {
            id: 'isagi-surfaces-terminal',
            kind: 'terminal',
            title: 'Terminal',
            shells: [
              {
                id: 'sh-surfaces-1',
                title: 'zsh',
                lines: [
                  '~/isagi/wt/surfaces ❯ git status -s',
                  ' M apps/web/src/routes/workspace/Canvas.tsx',
                  '~/isagi/wt/surfaces ❯',
                ],
              },
              {
                id: 'sh-surfaces-2',
                title: 'zsh',
                lines: ['~/isagi/wt/surfaces ❯ pnpm test', '✓ 48 passed', '~/isagi/wt/surfaces ❯'],
              },
            ],
          },
        ],
      },
      {
        id: 'isagi-resume',
        title: 'Agent session resume',
        branch: 'wt/resume',
        attention: 'waiting',
        parked: false,
        activeSurfaceId: 'isagi-resume-agents',
        commands: [
          {
            id: 'resume-dev',
            label: 'pnpm dev',
            status: 'running',
            attention: 'working',
            ports: [5180, 4001],
            log: ['$ pnpm dev', 'isagi:web  → http://localhost:5180/'],
          },
          {
            id: 'resume-typecheck',
            label: 'pnpm typecheck',
            status: 'stopped',
            attention: 'idle',
            ports: [],
            log: ['(not started — press run to start)'],
          },
        ],
        surfaces: [
          {
            id: 'isagi-resume-agents',
            kind: 'agent',
            title: 'Agents',
            agentSessions: [
              {
                id: 'h-claude',
                harness: 'claude',
                attention: 'waiting',
                transcript: ['# claude', '▌ overwrite the snapshot? (y/n)', '❯'],
              },
              {
                id: 'h-codex-review',
                harness: 'codex',
                attention: 'idle',
                transcript: ['# codex — reviewing the diff', '❯'],
              },
            ],
          },
        ],
      },
      {
        id: 'isagi-landing',
        title: 'Polish the landing page',
        branch: 'wt/landing',
        attention: 'idle',
        parked: false,
        activeSurfaceId: null,
        commands: [],
        surfaces: [],
      },
      {
        id: 'isagi-palette',
        title: 'Palette wizard polish',
        branch: 'wt/palette',
        attention: 'idle',
        parked: true,
        activeSurfaceId: 'isagi-palette-agents',
        commands: [
          {
            id: 'palette-lint',
            label: 'pnpm lint',
            status: 'stopped',
            attention: 'idle',
            ports: [],
            log: ['(not started — press run to start)'],
          },
        ],
        surfaces: [
          {
            id: 'isagi-palette-agents',
            kind: 'agent',
            title: 'Agents',
            agentSessions: [
              {
                id: 'h-pi-palette',
                harness: 'pi',
                attention: 'idle',
                transcript: ['# pi — idle', '❯'],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'acme-api',
    name: 'acme-api',
    glyph: 'A',
    accent: 'amber',
    worktrees: [
      {
        id: 'acme-main',
        title: 'Main',
        branch: 'main',
        attention: 'idle',
        parked: false,
        activeSurfaceId: null,
        commands: [],
        surfaces: [],
      },
      {
        id: 'acme-rate-limit',
        title: 'Token-bucket rate limiter',
        branch: 'wt/rate-limit',
        attention: 'idle',
        parked: false,
        activeSurfaceId: 'acme-rate-limit-agents',
        commands: [
          {
            id: 'acme-api',
            label: 'go run ./cmd/api',
            status: 'running',
            attention: 'working',
            ports: [8080],
            log: ['$ go run ./cmd/api', 'listening on :8080'],
          },
          {
            id: 'acme-test',
            label: 'go test ./...',
            status: 'exited',
            attention: 'error',
            ports: [],
            log: ['$ go test ./...', 'FAIL  ./ratelimit  0.2s', '✗ exited with code 1'],
          },
        ],
        surfaces: [
          {
            id: 'acme-rate-limit-agents',
            kind: 'agent',
            title: 'Agents',
            agentSessions: [
              {
                id: 'h-pi-rate',
                harness: 'pi',
                attention: 'idle',
                transcript: ['# pi — waiting for a task', '❯'],
              },
            ],
          },
        ],
      },
    ],
  },
];
