# Echo Maze product decisions

## Primary experiment: localization through language

Echo Maze's main mode keeps both Navigator and Walker. The experiment is not
whether an LLM can manually solve an 81-cell graph. It is whether Navigator can
infer Walker's hidden position from Walker's natural-language descriptions and
their shared interaction history.

The intended loop is:

1. **Localize** — Walker describes line of sight, walls, junctions, visible exit,
   previous movement results, and contradictions. Navigator maintains every
   still-plausible position.
2. **Lock a hypothesis** — Navigator decides that one position is sufficiently
   supported by the evidence. The hidden true position is never revealed to it.
3. **Acquire a route** — A deterministic maze-routing tool calculates a correct
   route from Navigator's claimed position to the exit. Route calculation is a
   provided capability, not the skill being evaluated.
4. **Guide and verify** — Navigator communicates one step at a time. Walker
   verifies each instruction against local perception before moving.
5. **Relocalize on contradiction** — A wall where Navigator expected a passage,
   a missing claimed exit, an unexpected junction, or another incompatible
   observation invalidates the current route. Navigator returns to localization
   and rebuilds its candidate set from the complete shared history.

The routing tool must use Navigator's claimed position, not Walker's hidden true
position. A wrong localization therefore produces locally inconsistent guidance
that Walker can challenge; the system must not silently reveal the answer.

## Memory responsibilities

- Navigator retains the complete shared conversation, accepted and challenged
  instructions, movement outcomes, candidate history, and hypothesized route.
- Walker retains local experience such as the previous action and whether a
  place appears revisited, but does not receive absolute coordinates or build a
  complete global route for Navigator.
- The UI may show a shortened event window, but agent memory and replay storage
  must remain complete and separate from that presentation limit.

## Deferred variant: Solo Walker

A Navigator-free mode is a future variant, not the current MVP. In that mode a
single Walker explores under partial observability, recognizes revisits, builds
an internal map, and reaches the exit. It can later serve as a baseline for
comparing individual spatial memory with language-mediated cooperation.

