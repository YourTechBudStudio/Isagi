import { Schema } from 'effect';

import { terminalSettingsBounds } from '@isagi/contracts';

function optionalBoundedInteger(maximum: number, description: string) {
  return Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum }))).annotate({
    description,
  });
}

export const runtimeConfigPtyBackendSchema = Schema.Literals(['node-pty', 'tmux']).annotate({
  description:
    'PTY backend used for new runtime-managed processes. Missing or null defaults to node-pty. Changing this setting requires restarting Isagi.',
});

export const runtimeHarnessPolicyEntrySchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      'Whether Isagi may create new processes for this harness. Missing defaults to false. Existing live processes remain attachable when disabled.',
  }),
  installIsagiDocs: Schema.optional(Schema.Boolean).annotate({
    description:
      'Whether Isagi maintains the reserved global isagi-docs skill in this harness native skill directory. Missing defaults to false and the value is ignored unless enabled is true. Disabling does not uninstall prior content.',
  }),
});

export const runtimeHarnessPolicySchema = Schema.Struct({
  pi: Schema.optional(runtimeHarnessPolicyEntrySchema),
  opencode: Schema.optional(runtimeHarnessPolicyEntrySchema),
  claude: Schema.optional(runtimeHarnessPolicyEntrySchema),
  codex: Schema.optional(runtimeHarnessPolicyEntrySchema),
}).annotate({
  description:
    'Per-harness process-creation and Isagi Docs installation policy. Missing harness entries default both settings to false. A present empty object completes onboarding with no enabled harnesses.',
});

export const runtimeWorkflowSettingsSchema = Schema.Struct({
  additionalDirectories: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      'Additional machine-global workflow collection directories, ordered from lower to higher priority. Entries must be absolute paths or use ~ for the current user home directory. Changes require restarting Isagi.',
  }),
}).annotate({
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
    }).annotate({
      description: 'Process-local retention settings for hidden terminal presentations.',
    }),
  ),
}).annotate({
  description:
    'Global terminal presentation history and cache retention settings. Missing fields use defaults. Changes require restarting Isagi.',
});

export const runtimeAppearanceSettingsSchema = Schema.Struct({
  theme: Schema.optional(Schema.Literals(['dark', 'light'])).annotate({
    description:
      'Color theme for the Isagi app: dark (Catppuccin Macchiato) or light (Catppuccin Latte). Missing defaults to light. Embedded editors keep their own theme. Changing it requires restarting Isagi.',
  }),
}).annotate({
  description:
    'How the Isagi app looks. Missing fields use defaults. Changes require restarting Isagi.',
});

// A value starting with `env.` names an environment variable; anything else is the key itself.
const fluidcastSecret = Schema.RedactedFromValue(
  Schema.String.check(Schema.isPattern(/^(?!env\.)|^env\.[A-Za-z_][A-Za-z0-9_]*$/)),
);
const fluidcastSecretDescription =
  'It stays in the runtime. Write env.NAME, for example env.OPENAI_API_KEY, to read it from the NAME environment variable of your login shell instead.';

// One language-model connection per provider, shared by `languageModel` and `summaryModel`.
const fluidcastConnectionCommon = {
  model: Schema.NonEmptyString.annotate({
    description: 'Model ID sent to the language-model API, for example gpt-5-mini.',
  }),
  baseUrl: Schema.optional(Schema.String).annotate({
    description:
      "API base URL. Missing uses the provider's default; set it for a proxy or a local server.",
  }),
  reasoningEffort: Schema.optional(
    Schema.Literals(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']),
  ).annotate({
    description: 'Reasoning effort. Missing uses the API default.',
  }),
  temperature: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
  ).annotate({
    description: 'Sampling temperature from 0 through 2. Missing uses the API default.',
  }),
  maxOutputTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: 'Upper bound on tokens per generation. Missing uses the API default.',
  }),
};

const fluidcastOpenAiConnection = {
  provider: Schema.Literal('openai').annotate({
    description: 'The OpenAI Responses API.',
  }),
  apiKey: fluidcastSecret.annotate({
    description: `API key for the language-model API. ${fluidcastSecretDescription}`,
  }),
  ...fluidcastConnectionCommon,
};

const fluidcastOpenAiCompatibleConnection = {
  provider: Schema.Literal('openai-compatible').annotate({
    description: 'Any OpenAI-compatible Chat Completions API, such as a local model server.',
  }),
  apiKey: Schema.optional(fluidcastSecret).annotate({
    description: `API key, if the server needs one. ${fluidcastSecretDescription}`,
  }),
  ...fluidcastConnectionCommon,
};

const fluidcastAnthropicConnection = {
  provider: Schema.Literal('anthropic').annotate({
    description: "Anthropic's Messages API.",
  }),
  apiKey: fluidcastSecret.annotate({
    description: `Anthropic API key. ${fluidcastSecretDescription}`,
  }),
  ...fluidcastConnectionCommon,
  model: Schema.NonEmptyString.annotate({
    description: 'Model ID sent to the Messages API, for example claude-sonnet-5-5.',
  }),
  reasoningEffort: Schema.optional(
    Schema.Literals(['low', 'medium', 'high', 'xhigh', 'max']),
  ).annotate({
    description: 'Effort: low, medium, high, xhigh or max. Missing uses the model default.',
  }),
  temperature: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  ).annotate({
    description:
      'Sampling temperature from 0 through 1. Missing uses the API default; newer models reject any other value.',
  }),
  fast: Schema.optional(Schema.Boolean).annotate({
    description:
      'Whether to request fast mode, which generates faster at a higher price. Only models that offer fast mode accept it. Missing defaults to false.',
  }),
};

export const runtimeFluidcastLanguageModelSchema = Schema.Union([
  Schema.Struct(fluidcastOpenAiConnection),
  Schema.Struct({
    ...fluidcastOpenAiCompatibleConnection,
    structuredOutput: Schema.optional(Schema.Boolean).annotate({
      description:
        "Whether to ask the server to constrain each reply to Fluidcast's output JSON Schema. Turn it on for local models that drift from the expected format. Missing defaults to false.",
    }),
  }),
  Schema.Struct({
    ...fluidcastAnthropicConnection,
    structuredOutput: Schema.optional(Schema.Boolean).annotate({
      description:
        "Whether to ask the API to constrain each reply to Fluidcast's output JSON Schema. Missing defaults to false.",
    }),
  }),
]).annotate({
  description: "The language model that writes the voice's replies.",
});

// Never valid: present, even as false, it is an issue at its own path.
const fluidcastSummaryStructuredOutput = Schema.optional(Schema.Never).annotate({
  description: 'Not accepted: only `languageModel` can constrain replies to the output schema.',
});

export const runtimeFluidcastSummaryModelSchema = Schema.Union([
  Schema.Struct({
    ...fluidcastOpenAiConnection,
    structuredOutput: fluidcastSummaryStructuredOutput,
  }),
  Schema.Struct({
    ...fluidcastOpenAiCompatibleConnection,
    structuredOutput: fluidcastSummaryStructuredOutput,
  }),
  Schema.Struct({
    ...fluidcastAnthropicConnection,
    structuredOutput: fluidcastSummaryStructuredOutput,
  }),
]).annotate({
  description:
    "An optional second, usually cheaper, language model that writes the progress sentences read while the agent works and the history summaries. It takes the same fields as languageModel except structuredOutput. Missing: the voice's model writes them.",
});

export const runtimeFluidcastSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      'Whether agent panes can switch to Fluidcast voice mode. Missing defaults to false; while false, the rest of this section is not validated.',
  }),
  languageModel: runtimeFluidcastLanguageModelSchema,
  summaryModel: Schema.optional(runtimeFluidcastSummaryModelSchema),
  speech: Schema.Struct({
    model: Schema.NonEmptyString.annotate({
      description: 'Text-to-speech model ID, for example gpt-4o-mini-tts.',
    }),
    apiKey: fluidcastSecret.annotate({
      description: `API key for the speech API. ${fluidcastSecretDescription}`,
    }),
    baseUrl: Schema.optional(Schema.String).annotate({
      description:
        "Base URL of an OpenAI-compatible /audio/speech API. Missing uses OpenAI's default.",
    }),
    format: Schema.optional(Schema.Literals(['opus', 'mp3', 'wav'])).annotate({
      description: 'Audio format of the spoken replies. Missing defaults to opus.',
    }),
  }).annotate({
    description: 'The speech connection, configured independently of the language model.',
  }),
  preset: Schema.Struct({
    profile: Schema.optional(Schema.Literals(['compact', 'detailed'])).annotate({
      description:
        'Guided Walkthrough profile: detailed adds speaking guidance and examples to the prompt; compact leaves them out. Missing defaults to detailed.',
    }),
    voice: Schema.Struct({
      name: Schema.NonEmptyString.annotate({
        description: 'Voice name the speech API accepts, for example alloy.',
      }),
      instructions: Schema.optional(Schema.String).annotate({
        description: 'Delivery instructions for the voice, for models that accept them.',
      }),
    }),
  }).annotate({ description: 'The Guided Walkthrough preset and its voice.' }),
  history: Schema.optional(
    Schema.Struct({
      compaction: Schema.optional(
        Schema.Struct({
          enabled: Schema.optional(Schema.Boolean).annotate({
            description: 'Whether to compact the history. Missing defaults to false.',
          }),
          aboveInputTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
            description:
              "Compact once the generation that forwards your words to the agent read more than this many input tokens: the provider's total, cache reads included. A provider that reports no count compacts after every forward. Missing defaults to 56000, which keeps the input within a 64K-token context window.",
          }),
        }),
      ).annotate({
        description:
          "Rolling summaries of the voice's conversation. Once a forward to the agent passes aboveInputTokens, everything before that forward is summarized in the background into one summary, which the voice reads in its place. Only the voice's view changes: you, the transcript and the agent keep the full conversation. The summary model writes it, else the voice's model. On paid APIs with cheap cache reads, such as Anthropic, it costs more than it saves unless a cheap model writes the summaries or the threshold is high. Off unless enabled is true.",
      }),
    }),
  ).annotate({ description: "How the voice's conversation history is kept." }),
}).annotate({
  description:
    'Fluidcast voice mode for Claude Code and Codex agent panes. Disabled unless enabled is true. An invalid section never stops Isagi from starting; voice mode is then unavailable. Changes require restarting Isagi.',
});

export const runtimeConfigSchema = Schema.Struct({
  pty: Schema.optional(
    Schema.Struct({
      backend: Schema.optional(Schema.NullOr(runtimeConfigPtyBackendSchema)),
    }).annotate({ description: 'Process-scoped PTY settings read when the runtime starts.' }),
  ),
  harnesses: Schema.optional(runtimeHarnessPolicySchema).annotate({
    description:
      'Harness policy. A missing section means onboarding is incomplete; use an explicit empty object to complete onboarding with every harness disabled.',
  }),
  workflows: Schema.optional(runtimeWorkflowSettingsSchema),
  terminal: Schema.optional(runtimeTerminalSettingsSchema),
  appearance: Schema.optional(runtimeAppearanceSettingsSchema),
  fluidcast: Schema.optional(runtimeFluidcastSchema),
}).annotate({ description: 'Runtime Isagi config from <dataRoot>/config.yaml.' });

export type RuntimeConfigPtyBackend = typeof runtimeConfigPtyBackendSchema.Type;
