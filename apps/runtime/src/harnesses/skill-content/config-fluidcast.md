# Fluidcast voice mode

The `fluidcast` section of the global config lets a Claude Code or Codex agent pane switch from its terminal to Fluidcast, a voice-and-visual player that talks through the same native agent conversation. Providers, fields and limits are in the [schema](config-global.schema.ts).

A hosted setup, with a cheaper model for summaries:

```yaml
fluidcast:
  enabled: true
  languageModel:
    provider: anthropic
    apiKey: env.ANTHROPIC_API_KEY
    model: claude-sonnet-5-5
  summaryModel:
    provider: anthropic
    apiKey: env.ANTHROPIC_API_KEY
    model: claude-haiku-5-5
  speech:
    apiKey: env.OPENAI_API_KEY
    model: gpt-4o-mini-tts
  preset:
    voice:
      name: alloy
```

A self-hosted model server for both the voice and speech:

```yaml
fluidcast:
  enabled: true
  languageModel:
    provider: openai-compatible
    baseUrl: http://localhost:8000/v1
    model: qwen
    structuredOutput: true
  history:
    compaction:
      enabled: true
      aboveInputTokens: 56000
  speech:
    baseUrl: http://localhost:8000/v1
    apiKey: placeholder-key
    model: voxtral-tts
    format: wav
  preset:
    voice:
      name: neutral_male
```

Model names are examples. Prefer `env.NAME` keys; Isagi reads them from the user's login-shell environment when it starts.

The pane's harness must be enabled under `harnesses` and launchable. A voice session lives in runtime memory only: leaving a pane pauses it, and restarting Isagi ends every voice session and returns the pane to its terminal with the native conversation kept. For Claude Code, attaching reads Claude's session files with the runtime's own environment, so a `CLAUDE_CONFIG_DIR` set only in the login shell is not seen and continuing a conversation stored under it can fail.
