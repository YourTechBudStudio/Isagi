# isagi-docs skill source

Every `.md` here except `AGENTS.md` and its `CLAUDE.md` symlink ships in the `isagi-docs` skill: `SKILL.md` at the root, the rest under `references/`, next to the two config schemas and the `minimal-workflow` scaffold. `{{DATA_ROOT}}`, `{{SDK_VERSION}}`, `{{VERIFIER_VERSION}}` and `{{BUILDER_VERSION}}` are substituted at install time.

Readers are capable agents that read schemas, types and examples well. Write for what they cannot infer.

## Principles

- **Route by task.** Each reference serves one task or domain a user asks about, not one config file or module. `SKILL.md` routes by task, holds every path an agent must get right, and can point straight at a schema when the schema is enough.
- **Schemas and types are the reference.** Fields, defaults, ranges, enum values and per-field rules live in schema descriptions and SDK TSDoc. When a fact about one field is missing, add it there. Prose carries only what they cannot: which option to choose when, interactions across fields or files, lifecycle, and gotchas that cause wrong edits.
- **Earn every sentence.** Keep a sentence only if an agent would act differently without it. Common sense and anything visible in the schema or an example get no prose.
- **One home per fact.** Link to it instead of restating it. Rules live in the topic files; recipes show shapes and link to the rules.
- **Minimal, real examples.** Show only the sections a task needs, so an agent that copies an example changes nothing else. Base examples on real configs and workflows rather than invented ones.
- **Recipes for workflow shapes.** Reusable code (agent turn, reading a reply, classification) compiles in `workflow-recipes.md`; larger patterns such as a review loop are described as bullets built from those blocks.
- **No conflicts.** Contradictory guidance makes agents stall. When prose and a schema disagree, fix the prose; `SKILL.md` already says the schema wins.

## Style

- State the behavior to follow; reserve "never" for real guardrails and pair it with what to do instead.
- Plain words, short paragraphs, the main point first. Use lists and tables for parallel items only.

## Mechanics

- No hard-wrapped prose. TypeScript fences must compile against the SDK (`isagi-docs-examples.test.ts`), YAML fences must decode against the config schemas, and every `isagi …` shell line must parse (`isagi-docs-cli.test.ts`).
- A new reference needs a row in `SKILL.md`. CLI references are named `cli-*.md`.
- After an edit, route a few realistic requests from `SKILL.md` and check that each lands on a file that answers it.
