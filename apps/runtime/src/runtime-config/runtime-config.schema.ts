import { Schema } from 'effect';

import { terminalSettingsBounds } from '@isagi/contracts';

function optionalBoundedInteger(maximum: number, description: string) {
  return Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(0, maximum))).annotations({
    description,
  });
}

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

export const runtimeTerminalSettingsSchema = Schema.Struct({
  scrollbackLines: optionalBoundedInteger(
    terminalSettingsBounds.scrollbackLines.maximum,
    'Normal-buffer terminal history in lines. Missing defaults to 5000. Accepts integers from 0 through 100000; zero retains only the active screen. This setting is global and changing it requires restarting Isagi.',
  ),
  cache: Schema.optional(
    Schema.Struct({
      idleTtlMinutes: optionalBoundedInteger(
        terminalSettingsBounds.cache.idleTtlMinutes.maximum,
        'Minutes a hidden terminal presentation may remain cached. Missing defaults to 180. Accepts integers from 0 through 10080; zero makes hidden heavy entries immediately ineligible. This setting is global and changing it requires restarting Isagi.',
      ),
      maxHiddenSessions: optionalBoundedInteger(
        terminalSettingsBounds.cache.maxHiddenSessions.maximum,
        'Maximum hidden terminal presentations retained in memory. Missing defaults to 4. Accepts integers from 0 through 32; zero makes hidden heavy entries immediately ineligible. This setting is global and changing it requires restarting Isagi.',
      ),
      maxEstimatedBufferMiB: optionalBoundedInteger(
        terminalSettingsBounds.cache.maxEstimatedBufferMiB.maximum,
        'Estimated parsed-buffer memory budget in MiB. Missing defaults to 64. Accepts integers from 0 through 2048; zero makes hidden heavy entries immediately ineligible. Visible terminals may temporarily exceed this budget. This setting is global and changing it requires restarting Isagi.',
      ),
    }).annotations({
      description: 'Process-local retention settings for hidden terminal presentations.',
    }),
  ),
}).annotations({
  description:
    'Global terminal presentation history and cache retention settings. Missing fields use defaults. Changes require restarting Isagi.',
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
  terminal: Schema.optional(runtimeTerminalSettingsSchema),
}).annotations({ description: 'Runtime Isagi config from <dataRoot>/config.yaml.' });

export type RuntimeConfigPtyBackend = Schema.Schema.Type<typeof runtimeConfigPtyBackendSchema>;
