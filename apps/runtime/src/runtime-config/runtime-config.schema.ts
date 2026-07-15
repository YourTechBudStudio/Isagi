import { Schema } from 'effect';

export const runtimeConfigPtyBackendSchema = Schema.Literal('node-pty', 'tmux').annotations({
  description:
    'PTY backend used for new runtime-managed processes. Missing or null defaults to node-pty. Changing this setting requires restarting Isagi.',
});

export const runtimeHarnessPolicyEntrySchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotations({
    description:
      'Whether Isagi may create new processes for this harness. Missing defaults to false. Existing live processes remain attachable when disabled.',
  }),
  installIsagiDocs: Schema.optional(Schema.Boolean).annotations({
    description:
      'Whether Isagi maintains the reserved explicit-only global isagi-docs integration. Missing defaults to false and the value is ignored unless enabled is true. Disabling does not uninstall prior content.',
  }),
});

export const runtimeHarnessPolicySchema = Schema.Struct({
  pi: Schema.optional(runtimeHarnessPolicyEntrySchema),
  opencode: Schema.optional(runtimeHarnessPolicyEntrySchema),
  claude: Schema.optional(runtimeHarnessPolicyEntrySchema),
  codex: Schema.optional(runtimeHarnessPolicyEntrySchema),
}).annotations({
  description:
    'Per-harness process-creation and Isagi Docs installation policy. Missing harness entries default both settings to false. A present empty object completes onboarding with no enabled harnesses.',
});

export const runtimeWorkflowSettingsSchema = Schema.Struct({
  additionalDirectories: Schema.optional(Schema.Array(Schema.String)).annotations({
    description:
      'Additional machine-global workflow collection directories, ordered from lower to higher priority. Entries must be absolute paths or use ~ for the current user home directory. Changes require restarting Isagi.',
  }),
}).annotations({
  description:
    'Workflow discovery settings. Additional directories extend the built-in data-root and project workflow sources.',
});

export const runtimeConfigSchema = Schema.Struct({
  pty: Schema.optional(
    Schema.Struct({
      backend: Schema.optional(Schema.NullOr(runtimeConfigPtyBackendSchema)),
    }).annotations({ description: 'Process-scoped PTY settings read when the runtime starts.' }),
  ),
  harnesses: Schema.optional(runtimeHarnessPolicySchema).annotations({
    description:
      'Harness policy. A missing section means onboarding is incomplete; use an explicit empty object to complete onboarding with every harness disabled.',
  }),
  workflows: Schema.optional(runtimeWorkflowSettingsSchema),
}).annotations({ description: 'Runtime Isagi config from <dataRoot>/config.yaml.' });

export type RuntimeConfigPtyBackend = Schema.Schema.Type<typeof runtimeConfigPtyBackendSchema>;
