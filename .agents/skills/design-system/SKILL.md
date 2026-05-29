---
name: design-system
description: Use when designing, implementing, or reviewing any frontend UI, copy, documentation, README, or marketing surface for Isagi. Grounds visual style, typography, motion, spatial language, voice, and copy patterns in Isagi's design language — Catppuccin Macchiato pastels on a deep canvas, distinctive display typography paired with a humanist body, liquid-glass motion with soft expo-out landings, dry deadpan dev-humour confined to empty and edge surfaces, and an embedded work surface that is always the hero of the screen.
---

# Isagi Design System

## What this skill is

Isagi's design language, expressed as principles with anchor examples. Applied to mockups, components, copy, documentation, READMEs, and marketing surfaces. The bar is intentional, restrained, production-grade, and immediately recognizable as Isagi.

This skill is a guardrail, not a generator. It grounds work in a coherent house style and pushes back when it drifts toward generic AI-slop aesthetics.

## The voice — made by a dev, for devs

Voice is the single most identifiable thing about Isagi. Get this right and most other things follow.

- **Deadpan over enthusiastic.** Isagi states what is true; it does not perform delight. *Anchor: a footer that reads `Built for developers who ship.` with a low-opacity `// console.log("hello")` next to it.*

- **Self-aware over polished.** Acknowledge the boring parts; don't dress them up. *Anchor: a billing menu item described as `Plans, payments, the boring stuff` — not "Manage your subscription."*

- **Conversational, never marketing-speak.** Real sentences. The kind a developer would write in a Slack message at 11pm. *Anchor: an empty search result that says `No matches. Maybe try a different query?` rather than "0 results found."*

- **The personality lives in copy and typography, not in motion or buttons.** The wink happens in a sentence, in a code comment, in a low-opacity mono aside — never in a bouncy modal.

## Palette — Catppuccin Macchiato

Pastel accents on a deep canvas. Character comes from atmospheric depth, not from saturated brand colors.

- **The canvas is the spine.** Deep neutrals carry most of the surface; pastels are sparse accents. *Anchor tokens: canvas `#24273a`, elevated `#363a4f`, subtle `#2e3244`. Text steps `#cad3f5` → `#a5adcb` → `#6e738d`. Accents: blue `#8aadf4`, violet `#c6a0f6`, amber `#f5a97f`, green `#a6da95`, red `#ed8796`, cyan `#91d7e3`.*

- **Accents earn their use.** Pick one or two accents per surface and let them dominate. Reaching for all six in one view is a smell. *Anchor: a "thinking" state uses violet alone; a "ready" state uses cyan alone. Two pastels in dialogue, not a rainbow.*

- **Reserve red.** Red is for genuine destruction or genuine error. Form-validation noise, "unsaved changes" hints, and minor warnings use amber or text-tertiary instead. *Anchor: a "Delete session" confirmation uses red; "Unsaved" uses amber; a missing field nudges in text-tertiary.*

## Typography

Distinctive display + humanist body + monospace for code and asides.

- **Display fonts are characterful, not generic.** A geometric or warm display font with personality leads every hero. *Anchor: Sora as the display family. Anything used on every AI-generated landing page is the wrong choice.*

- **Body fonts are humanist and quiet.** They support reading without competing with the display. *Anchor: Source Sans 3 as the body family. Readable at 14–16px, comfortable for dense UI.*

- **Mono is a brand tool, not just a code tool.** Monospace doubles as the typographic whisper for humour, signatures, and asides. The named pattern lives under Copy & humour.

- **Type hierarchy is decisive.** Sizes step clearly. Weights pick a side. Letter-spacing is intentional, especially for uppercase section labels. *Anchor: small uppercase overlines at 12px, +2% letter-spacing, in text-tertiary — used as quiet section labels.*

## Motion language — liquid glass

The signature is **fast start, soft landing** — responsive at the moment of contact, gentle as it arrives.

- **One easing curve, used everywhere.** The signature curve is expo-out: quick at the start, easing into a soft stop. *Anchor: `cubic-bezier(0.16, 1, 0.3, 1)` for every transition unless there is a deliberate reason to deviate.*

- **Duration scales with deliberateness.** Frequent micro-interactions are nearly instant. Rare, intentional moments get the time to breathe. *Anchor ladder: hover / focus / press 80–120ms · tooltip / dropdown 150–200ms · palette / modal / panel 280–350ms · session switch / onboarding / success 500–800ms.*

- **The liquid feel comes from glass and halos, not from springs.** Backdrop-filter blur, layered pastel halos behind translucent surfaces, and the soft landing curve do the work. *Anchor: a command palette overlay sits on a blurred backdrop, scales in from 98.5% to 100% with a 6px translate-Y, lands on the expo-out curve.*

- **Morphing UI over reflow.** When a surface needs to grow new inputs or shift its shape, animate the morph using the same curve. A palette that expands to reveal a parameter input should feel like one continuous surface, not a re-mounted modal.

- **One orchestrated entrance beats scattered micro-animations.** A page load may stagger reveals across hero elements; the rest of the page should not constantly twitch. Save the choreography for moments worth choreographing.

## Spatial composition

- **Pick a side: generous space or controlled density.** The timid middle — comfortably padded, evenly spaced, mildly cramped — is the AI-slop default. Either let the layout breathe or commit to dense, structured information. *Anchor: a session list can be airy with tall row heights and quiet dividers; a milestone view can be tight and information-rich. Both are valid; the middle is not.*

- **Asymmetry and overlap, where they help.** A grid is a default, not a rule. Off-axis placements, overlap between surfaces, and grid-breaking accents create visual rhythm. *Anchor: a hero section where the primary action sits off-center and a faint halo extends beyond the surface boundary.*

- **Negative space is structural.** Empty space is part of the composition, not a sign that something is missing. Resist the urge to fill it.

## Backgrounds & atmosphere

Never flat. The canvas always has depth.

- **Layered pastel halos are the atmospheric signature.** Two or three soft radial gradients in the accent palette, low opacity, positioned to suggest depth without competing with content. *Anchor: blue blob top-left, violet top-right, cyan bottom-center, each at ~14% opacity, over the canvas.*

- **Texture is optional but welcome.** Grain overlays, subtle geometric patterns, layered transparencies — used sparingly — add warmth and material quality. *Anchor: a faint grain overlay on a hero card to take the digital sheen off.*

- **Shadows are soft and layered, not dropped.** A single hard drop shadow looks like a default framework component. Layered, low-opacity shadows give depth without weight. *Anchor: `0 16px 48px rgba(0, 0, 0, 0.4)` on a menu surface — diffuse, deep, never crisp.*

## Copy & humour patterns

Named patterns that make Isagi's voice recognizable. Use them deliberately; don't sprinkle them.

- **The mono whisper.** A low-opacity monospace aside in a corner, footer, or tip bar. Acts as the author's signature on the surface. *Anchor: a palette tip bar reading `tip: cmd+k from anywhere` with mono on the shortcut and 40% opacity overall.*

- **The self-aware aside.** Name the thing plainly, then add a deadpan footnote that acknowledges what it really is. *Anchor: `Billing & Usage — Plans, payments, the boring stuff.`*

- **The conversational empty state.** Empty states are full sentences with a small warmth, not stock "No results" labels. *Anchor: `Nothing here yet. Start a session and Isagi will remember where you left off.`*

- **Code-as-decoration.** A comment-shaped line of code, set in mono at low opacity, used as a signature or a sign-off. *Anchor: a marketing-page footer with `// p.s. cmd+k works from anywhere` in mono at 30% opacity.*

- **Plain-language micro-copy.** Buttons and labels say what they do. No "Empower your workflow." No "Unlock potential." *Anchor: a button labeled `Resume last session` — not "Continue your journey."*

### Where humour lives

404 pages, empty states, onboarding moments, footers, palette tip bars, loading text on rare slow operations, error messages on user-fixable problems, marketing-page asides, code comments visible in `view source`, easter eggs.

### Where humour is forbidden

Primary CTAs. Working chrome — sidebars, headers, action bars during normal use. Agent status lines. Destructive confirmations. Validation errors on form fields. Anything a power user sees more than a few times per session. Anything an enterprise user might screenshot for their team lead.

Humour that ages well is rare and deadpan. Humour that ages like milk is constant and trying.

## Designing for an agent orchestrator

- **The user's primary work surface is the hero.** Everything else recedes to support it. The shell exists to frame the work, not compete with it. *Anchor: when an embedded terminal is the work surface, sidebars and toolbars sit at lower contrast than the terminal itself; the canvas around the terminal is quiet enough that focus naturally lands inside.*

- **Agent activity is communicated calmly.** Working states breathe; waiting states are still. Differentiate "I'm doing something" from "I need you" without making either feel anxious. *Anchor: a slow ambient pulse for streaming work, a steady soft glow for "ready for input," never a frantic spinner.*

- **Continuation is first-class.** What the user was doing, where they left off, and what comes next belong in the spine of the app — not buried behind menus. *Anchor: the resume action belongs in the command palette's top slot and on the home surface; not three clicks deep in a sessions list.*

- **Long-running work breathes; it does not spin.** Spinners belong on sub-second operations. Anything that takes real time should communicate progress through ambient motion or actual status, not by spinning in place. *Anchor: an agent generating a response shows a slow waveform or pulse with a one-line status, not a spinning ring.*

- **Status copy is dry and informative.** It states what is happening. Personality belongs elsewhere. *Anchor: `Streaming response...` not "✨ Thinking real hard ✨". `Waiting on your input.` not "Your turn! 🎯".*

- **Power use never requires a mouse.** Primary navigation, search, and actions are reachable from the keyboard. *Anchor: a command palette is the canonical pattern, but the principle is keyboard-reachable primary actions, not the palette specifically.*

## Anti-patterns — the smell test

If a surface has any of these, it has drifted from Isagi. Treat the list as a hard ban.

- Inter, Roboto, Arial, or unmodified system font stacks as primary type.
- Stock landing-page gradients — purple-on-white, cyan-to-pink, anything that has shipped on a template.
- Solid flat backgrounds on hero surfaces.
- Symmetric centered card grids as the default layout.
- Spring-bouncy modals, theatrical scale animations, anything that overshoots.
- Loading spinners on operations that take more than ~2 seconds.
- "✨ AI is thinking ✨" — or any variation. Sparkle emoji on AI surfaces, ever.
- Emoji-decorated CTAs. All-caps shouty buttons.
- "Welcome to Isagi!" empty states. Any empty state that congratulates the user for arriving.
- Humour in primary actions, in destructive confirmations, or in surfaces seen on every interaction.
- "Empower," "unlock," "supercharge," "seamless," "delightful" — anywhere.
- Evenly-distributed six-accent palettes. Rainbow tag chips.
- Hard drop shadows. Crisp `box-shadow: 0 2px 4px rgba(0,0,0,0.1)` defaults.
- Loading text that performs cuteness while the user is waiting.

## Intentionality bar

- **Restraint is a feature.** Match implementation complexity to the design vision. A refined surface with three carefully chosen elements outperforms a maximalist one with twenty.
- **Every decoration earns its place.** If a halo, gradient, animation, or copy aside cannot defend itself, cut it.
- **Coherence over novelty.** When in doubt, repeat an existing pattern rather than invent a new one.
- **When in doubt, do less and execute it with precision.**

The goal is not to make Isagi look interesting. The goal is to make Isagi feel like a tool a particular kind of developer built for themselves, and was generous enough to share.
