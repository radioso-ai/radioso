# Agent Context Workflow

This workflow keeps new feature work from starting with a full-repo read. It is
for agents and contributors who need enough context to work safely without
loading every nearby file.

## Context Sources

Use each source for its intended lifetime:

- `AGENTS.md`: durable repo rules, stack, commands, and architecture guardrails.
- `docs/architecture/code-map.md`: stable map from product area to owner,
  public surface, tests, and related docs.
- `specs/<feature>/`: approved feature requirements, plans, contracts, and task
  breakdowns.
- `docs/`: durable architecture, operator, SDK, and product documentation.
- `.context/`: temporary handoff notes for the current workspace. This directory
  is gitignored.

Do not put run logs, one-off feature notes, or temporary task state in
`AGENTS.md`.

## Starting A Feature

1. Read `AGENTS.md`.
2. Find the likely product area in [Code Map](./architecture/code-map.md).
3. If the product area has a source-area `README.md`, read it before opening
   service files.
4. Read only the area's public surfaces and directly related docs or specs.
5. Use `rg` to find current call sites and tests.
6. Write a short `.context/<feature>.md` brief when the work spans more than one
   area or will be handed between agents.
7. Update the brief as decisions change. Keep durable conclusions in `docs/` or
   `specs/` before the work ships.

## Feature Brief Template

Use this template in `.context/<feature>.md`:

```markdown
# Feature Brief: <name>

## Goal

<One or two sentences describing the user-visible outcome.>

## Product Area

- Primary owner:
- Secondary areas:
- Code map section:

## Relevant Files

- `<path>`: <why it matters>

## Contracts And Boundaries

- Public APIs:
- SDK contracts:
- MCP contracts:
- Worker or queue payloads:
- Module public surfaces:

## Decisions

- <Decision and reason.>

## Open Questions

- <Question, owner, and what blocks on it.>

## Tests

- Focused:
- Broader:

## Handoff Notes

- <What the next agent or reviewer should know first.>
```

## When To Promote Notes

Promote `.context/` notes when they become durable:

- Product behavior or setup guidance belongs in `docs/` or `docs-portal/content/`.
- Architecture decisions belong in `docs/architecture/` or a feature spec.
- Public API, SDK, MCP, or worker payload changes belong in the relevant
  contract docs and tests.
- Temporary observations, failing command output, and coordination notes stay in
  `.context/`.

## Context Budget Checklist

Before reading another large directory, check:

- Is there a public surface or contract for this module?
- Is this covered by an existing spec?
- Is there a focused test that describes the behavior?
- Can `rg` answer the current question more cheaply than opening files?
- Is the issue actually a missing boundary or map entry?

If the same area repeatedly needs broad rediscovery, add or update a small
durable map entry instead of expanding `AGENTS.md`.
