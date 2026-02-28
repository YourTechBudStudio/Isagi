# Isagi Development Guide

This guide provides essential information for agentic coding agents operating in this repository.

## Project Overview

Isagi (codename) is a context continuity engine: capture raw ideas ("sparks"), then turn them into durable artifacts via warm-start agent conversations where the system pre-loads everything needed so you never start from zero.

This repo is currently ideation-stage; `docs/` is the primary source of truth.

## Project Structure

All deployables live in `apps/`. All shared libraries/config live in `packages/`.

```txt
docs/             # product framing + mental model + MVP scope (living documents)
scratch/          # scratch notes / temporary working docs (non-canonical)

apps/
  api/            # Node + Express; SSE; SQLite + filesystem artifacts; voice STT
  web/            # Vite + React SPA (desktop-first deep work)
  mobile/         # DISCONTINUED for current MVP phase (do not modify unless explicitly requested)

packages/
  contract/       # shared schemas + API contract + SSE event types
  tooling/        # shared eslint/tsconfig/prettier setup (Fluidcast-style)

vendor/
  opencode/       # git submodule; upstream OpenCode source (SDK reference)
```

## OpenCode Submodule

This repo vendors the upstream OpenCode repository as a git submodule so agents can inspect the actual SDK/source when docs are unclear.

- Location: `vendor/opencode/`
- After cloning: `git submodule update --init --recursive`
- To bump the pinned revision: `git submodule update --remote --merge vendor/opencode` then commit the updated gitlink
- When answering OpenCode SDK questions, start with: `vendor/opencode/sdks/`, `vendor/opencode/specs/`, and `vendor/opencode/packages/`

## Build, Lint, and Test Commands

### Root Level Commands

```bash
# Install dependencies
pnpm install

# Lint all packages
pnpm lint

# Format all packages
pnpm format

# Run tests
pnpm test

# Run commands on specific packages (monorepo)
pnpm <package|app>

# Example
pnpm <package|app> lint
```

## Development Philosophy

**Think from first principles.** Don't accept how things are-understand why they should be that way.

### Question Everything

- **Challenge assumptions**: Before implementing, ask "Why does this need to exist? What problem does it solve?"
- **Reject cargo culting**: "It matches the existing code" or "that's how it's always been done" are not valid justifications
- **Trace to root causes**: When something seems wrong, dig until you find the actual source, not just symptoms

### Prefer Simplicity

- **Start with the simplest solution**: Add complexity only when you can articulate exactly why it's needed
- **Delete before adding**: Can you remove something instead of working around it?
- **One way to do things**: If two approaches exist for the same task, pick one and eliminate the other

### Unify Aggressively

- **Same concept = same name**: If two things represent the same concept, use the same name
- **Same concept = same structure**: Minor variations usually indicate accidental drift, not intentional design
- **When in doubt**: Ask "If I were designing this from scratch today, would I create two different things here?"

## Code Style Guidelines

### TypeScript Conventions

- **Always enable strict mode**: All TypeScript code must use strict type checking
- **Explicit return types**: Prefer explicit return types on public functions
- **Avoid `any`**: Use `unknown` or more specific types instead of `any`
- **Use readonly**: Mark arrays and objects as `readonly` when they shouldn't be mutated

### Naming Conventions

- **Classes**: PascalCase (e.g., `FluidcastViewProvider`)
- **Interfaces**: PascalCase with optional "I" prefix discouraged (e.g., `WebviewViewProvider`)
- **Variables/Functions**: camelCase (e.g., `resolveWebviewView`, `extensionUri`)
- **Constants**: SCREAMING_SNAKE_CASE for values, camelCase for function exports
- **Unused parameters**: Prefix with underscore (e.g., `_context`, `_token`)

## Architecture Documentation

See `docs/README.md` for architecture and product documentation.

## When to Use Skills

This section provides guidance on when agents should load specific skills.

### Brainstorming Skill

**When to load:** Trigger the brainstorming skill automatically when the user:

- Wants to brainstorm ideas or explore possibilities
- Asks to "figure something out" or "figure out how to do X"
- Wants to brainstorm or explore architecture/product/UX approaches (frontend or backend)
- Engages in conversational sessions to determine what needs to be done
- Asks open-ended questions about approach, strategy, or design decisions
- Needs help thinking through problems before implementation

If the brainstorming is about UI/UX design elements (components, layouts, visual direction), also load `frontend-design` (see Skill combos).

**Examples:**

- "How should we structure the data model for this feature?"
- "Let's figure out the best way to handle user authentication"
- "I want to design the UX for the new dashboard"
- "What's the best approach for caching in this scenario?"

### Frontend Design Skill (`frontend-design`)

**When to load:** Trigger `frontend-design` automatically when the user is doing **macro UI/UX work** in a frontend codebase.

Macro UI/UX work includes:

- Designing or implementing new components, page sections, or layouts
- "Polish this page" / "make it look better" / visual refresh or re-theme work
- Defining component-level UX patterns and states (including empty/loading/error states and copy)
- Motion/interaction design at the component/page level

**When NOT to load:** Do NOT load it for small UI tweaks (minor spacing/alignment, tiny color nudges, one-off copy edits) unless they are part of a larger component/layout redesign.

**Examples (load `frontend-design`):**

- "Design a new dashboard layout"
- "Add a new landing page section to the website"
- "Create a reusable card component with empty/loading/error states"
- "Polish this page / make it look better"

**Examples (don't load `frontend-design`):**

- "Change padding from 8 to 12"
- "Align this button"
- "Rename this label"

**Important:** Load this skill before making macro visual/layout decisions to ensure design consistency.

### Skill combos (load multiple)

**UI/UX brainstorming:** If the user is exploring/brainstorming UI/UX/design (not just implementing a decided change), load BOTH:

- `brainstorming`
- `frontend-design`

**UI implementation:** If the user has a clear UI spec and wants it implemented, load ONLY:

- `frontend-design`

## Notes for Agents

- Changes may affect multiple packages as the repo grows.
- Always run `pnpm install` after modifying dependencies.
- Always run `pnpm <app|package> format && pnpm <app|package> lint` after creating new files.
- Mobile app work is out of active MVP scope; do not edit `apps/mobile` unless the user explicitly asks.
- When making architectural changes, ask yourself: "Should this be documented?"
- Load the `documentation` skill when:
  - Adding new components or subsystems
  - Changing component responsibilities
  - Modifying interaction patterns between systems
  - User asks about architecture/design decisions
- Read existing docs before adding new ones to avoid duplication.
