# Global config

## Harness policy

The top-level `harnesses` section controls whether Isagi may create new processes for each supported harness and whether it maintains the reserved global `isagi-docs` skill for that harness. The skill may be selected automatically for Isagi-specific requests according to its description. Missing entries and booleans default to `false`. A missing `harnesses` section means onboarding is incomplete; `harnesses: {}` is a completed policy with no enabled harnesses.

```yaml
harnesses:
  codex:
    enabled: true
    installIsagiDocs: true
```

Disabling a harness or Docs installation does not remove content installed earlier. Isagi replaces the exact `isagi-docs` skill folder when installation is enabled; edits to that reserved target are not preserved on reconciliation. Each harness receives a complete copy in its own global skill directory, including every bundled reference file.

Runtime configuration. One file, shared by every project on this machine.

## The file

```
{{DATA_ROOT}}/config.yaml
```

It may not exist. Isagi runs on defaults when it is missing, so creating it is the normal way to change a setting for the first time.

Isagi reads the file at startup. The runtime policy API updates the live harness policy after an accepted write; manual YAML edits take effect on the next restart. PTY backend changes always require a restart.

Project-level settings - hooks and commands - do not live here. They live in `.isagi/config.yaml` in the repository root and are described in [Project config](config-project.md).

## Choosing a pty backend

`node-pty` is the default and the path Isagi is built around. It requires no external process.

`tmux` is an optional transport for the processes Isagi launches. It is not a restoration or continuity mechanism - Isagi restores sessions from its own durable state either way, and a tmux server that survives a crash does not change what Isagi recovers. Select it only when the user has a specific reason and tmux is installed.

```yaml
pty:
  backend: node-pty
```

To switch:

```yaml
pty:
  backend: tmux
```

Omitting `pty`, omitting `backend`, or setting `backend: null` all mean `node-pty`. A `backend` value that is present but is neither `node-pty` nor `tmux` is rejected, and Isagi will not start with it.

## Additional workflow directories

Isagi discovers workflow packages under the global data root (`{{DATA_ROOT}}/workflows/<key>/`) and under each project (`.isagi/workflows/<key>/`). The `workflows.additionalDirectories` setting adds machine-global collection roots to that discovery without replacing either built-in root.

```yaml
workflows:
  additionalDirectories:
    - ~/isagi-workflows
    - /opt/team/isagi-workflows
```

Each entry is a collection root that contains `<key>/` package directories — the same layout as `{{DATA_ROOT}}/workflows/` — not a path to a single workflow package.

Rules for each entry:

- It must be a native absolute path, or `~` / `~/...` for the current user's home directory. Quote the exact home-directory entry as `"~"` because an unquoted `~` is YAML null. Isagi expands `~` and normalizes the result.
- Relative paths, paths resolved against the config file or the current directory, environment variables, and another user's `~otheruser` are not supported. A malformed entry prevents Isagi from starting.

Precedence follows the source order, from lowest to highest priority: the global data-root workflows first, then each configured directory in the order listed so a later entry outranks an earlier one, then the project's `.isagi/workflows`. When more than one source defines the same workflow key, the highest-priority source owns it; a broken winning package makes that key fail rather than falling back to a lower-priority copy.

A configured directory that does not exist is skipped, and Isagi warns once for it. A configured directory that exists but cannot be read — a file where a directory was expected, or an unreadable path — is a discovery error, not an empty source.

Isagi validates this setting's shape and path rules when it starts, and validates each winning workflow package later — when workflow descriptors are listed and again immediately before a run starts, never at startup. Changes to `workflows.additionalDirectories` take effect only after Isagi restarts.

## Terminal history and cache retention

The top-level `terminal` section controls terminal presentation history and the process-local cache used to keep hidden terminal sessions warm. These settings are global to every project and manual changes take effect after Isagi restarts.

```yaml
terminal:
  scrollbackLines: 5000
  cache:
    idleTtlMinutes: 180
    maxHiddenSessions: 4
    maxEstimatedBufferMiB: 64
```

`scrollbackLines` defaults to `5000` and accepts integers from `0` through `100000`. Zero retains only the active terminal screen.

`idleTtlMinutes` defaults to `180` and accepts integers from `0` through `10080`. `maxHiddenSessions` defaults to `4` and accepts integers from `0` through `32`. `maxEstimatedBufferMiB` defaults to `64` and accepts integers from `0` through `2048`.

Zero for any cache limit makes hidden heavy terminal entries immediately ineligible for retention. It does not delete the small viewport metadata Isagi keeps for the current app process. Visible terminals are never evicted and may temporarily exceed the configured estimated-buffer budget.

Omitting `terminal`, `cache`, or any nested field applies the documented default. A malformed value prevents Isagi from starting. Configure these settings only in `{{DATA_ROOT}}/config.yaml`; `.isagi/config.yaml` is project configuration and does not own terminal history or cache retention.

## Fluidcast voice mode

The top-level `fluidcast` section lets a Claude Code or Codex agent pane switch from its terminal to Fluidcast, a voice-and-visual player that talks through the same native agent conversation. It is off unless `enabled: true`; while it is off, Isagi does not validate the rest of the section.

```yaml
fluidcast:
  enabled: true
  languageModel:
    provider: openai
    apiKey: sk-your-openai-key
    model: gpt-5-mini
  speech:
    apiKey: sk-your-openai-key
    model: gpt-4o-mini-tts
  preset:
    voice:
      name: alloy
```

The language model, which writes the voice's replies, and the speech connection are configured independently, each with its own `apiKey`, `model` and optional `baseUrl`. They may point at different services.

- `languageModel.provider: openai` uses the OpenAI Responses API and requires `apiKey`.
- `languageModel.provider: openai-compatible` uses any OpenAI-compatible Chat Completions API, such as a local model server at `baseUrl`; `apiKey` is optional. Set `structuredOutput: true` when a local model drifts from the reply format: Isagi then asks the server to constrain every reply to Fluidcast's output JSON Schema.
- `languageModel.provider: anthropic` uses Anthropic's Messages API and requires `apiKey`. Its `reasoningEffort` is `low`, `medium`, `high`, `xhigh` or `max`, and its `temperature` runs from 0 through 1; newer Claude models reject any temperature, so leave it unset for them. `structuredOutput: true` asks the API to constrain every reply to Fluidcast's output JSON Schema; it is off by default. `fast: true` requests fast mode, which generates faster at a higher price and only some models accept; it is off by default.
- `languageModel` also accepts `reasoningEffort`, `temperature` and `maxOutputTokens`; missing values use the API's defaults.
- `speech` targets an OpenAI-compatible `/audio/speech` API. `format` is `opus` (the default), `mp3` or `wav`.
- `preset` picks the Guided Walkthrough profile, `detailed` (the default) or `compact`, and the voice: `voice.name` as the speech API knows it, plus optional delivery `instructions`.

```yaml
fluidcast:
  enabled: true
  languageModel:
    provider: openai-compatible
    baseUrl: http://localhost:1234/v1
    model: local-model
    structuredOutput: true
  speech:
    baseUrl: http://localhost:8880/v1
    apiKey: placeholder-key
    model: tts-1
    format: mp3
  preset:
    profile: compact
    voice:
      name: af_sky
      instructions: Calm and unhurried.
```

```yaml
fluidcast:
  enabled: true
  languageModel:
    provider: anthropic
    apiKey: env.ANTHROPIC_API_KEY
    model: claude-sonnet-5-5
  speech:
    apiKey: env.OPENAI_API_KEY
    model: gpt-4o-mini-tts
  preset:
    voice:
      name: alloy
```

Any `apiKey` may be written as `env.NAME` to read the key from the `NAME` environment variable instead of writing it into the file. Isagi reads the variable from your login shell's environment, the same one agent terminals get, when it starts. Only the lowercase `env.` prefix is a reference, and `NAME` must be a valid variable name. If the variable is unset or empty, voice mode is unavailable and the runtime log names the field and the variable, never a value.

Keys written inline stay in the runtime: Isagi never sends them to the app, and its errors and logs never print config text. Isagi reads this section at startup, so changes take effect only after Isagi restarts. An invalid enabled section never stops Isagi from starting; voice mode is unavailable until it is fixed, and the runtime log names the invalid fields.

The agent pane supplies everything else. The harness, working directory and executable come from the agent session, and Isagi instruments the voice session's worker the same way it instruments the terminal, so hook-based status and attention keep working. The harness must be enabled under `harnesses` and launchable. Only Claude Code and Codex support voice mode.

A voice session lives in the runtime's memory only. Leaving a pane pauses it and returning resumes it paused, but restarting Isagi ends every voice session and returns each agent pane to its terminal; the native conversation itself is kept. For Claude Code, Isagi resolves `claude` on your login shell's `PATH`, but the Fluidcast attach step reads Claude's session files using the runtime's own environment: a `CLAUDE_CONFIG_DIR` set only in your login shell is not seen there, so continuing a conversation stored under it can fail.

## Schema

For exact fields, defaults, and constraints, read the [validated schema](config-global.schema.ts). Its field descriptions are authoritative when prose and schema disagree.
