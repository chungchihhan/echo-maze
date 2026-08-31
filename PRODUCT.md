# Product

## Register

product

## Users

The developer-spectator: someone reviewing experiments on whether a single LLM
agent can navigate a hidden maze. They scrub recorded runs to see where the
Walker's spatial model was right, wrong, or recovered. Context: desktop browser,
focused observation sessions.

## Product Purpose

Echo Maze is an observable AI-agent game. One Solo Walker (gpt-5.6-luna)
navigates a generated maze using only corridor line-of-sight and its own
conversation memory. The interface makes the agent's belief and the maze's
reality comparable side by side. Success = a legible instrument for studying
agent memory and partial observability, with every run replayable.

## Brand Personality

Precise, observational, quietly playful. Three words: instrument-panel,
laboratory, maze. The interface should feel like a research rig you enjoy
looking at — bold binary cobalt/ice, one typeface, 1px lines — never like a
marketing site and never like a generic SaaS dashboard.

## Anti-references

- Generic SaaS dashboard (cards, soft shadows, Inter-everywhere).
- Two-agent "cooperation" framing anywhere in the UI (current product is one
  Solo Walker).
- Decorative effects that don't convey game or agent state.
- Hidden-state leakage: spectator map info must never imply it is visible to
  the Walker.

## Design Principles

1. Belief vs. reality is the product: keep the reasoning log and the maze view
   visually equal partners.
2. One voice: binary cobalt/ice, weight 400, 1px borders instead of shadows.
3. Motion only when it conveys state (thinking, moving, blocked, won, live).
4. The tool loads into the task — the hero frames the question, the console and
   panels stay within reach.
5. UI text is an observable summary, never hidden chain-of-thought.

## Accessibility & Inclusion

- WCAG AA: body text ≥ 4.5:1 on its surface; active-state chips and tags must
  not rely on low-contrast mist-on-ice for meaningful text.
- `prefers-reduced-motion` respected for all animation.
- English interface language (`lang="en"`), keyboard-visible focus states.
