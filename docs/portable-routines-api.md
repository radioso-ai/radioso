---
title: "Portable Routines API"
description: "How to create, read, update, and canonicalize deterministic routine markdown through the API."
last_updated: 2026-07-13
---

# Portable Routines API

The portable routines API accepts deterministic routine markdown in a JSON
envelope. It is for callers who keep routine definitions as files, generate them
from code, or move them between environments.

The API does not call an LLM. It parses the markdown with
`@radioso/routine-markdown`, maps it to the same structured routine definition
used by the dashboard, and then runs normal routine validation.

## Envelope

Every endpoint uses `application/json`.

```json
{
  "grammarVersion": 1,
  "content": "---\ngrammar: 1\nname: Refund check\ntrigger: customer asks for a refund\n---\nAsk for @order_id.\n-> end"
}
```

`grammarVersion` is the version of the envelope and must match the grammar
version in the content. The current value is `1`.

Responses return the same envelope shape. Mutating endpoints return canonical
markdown. For create, the response also includes `routineId`.

## Endpoints

```text
GET  /api/v1/agents/{agentId}/routines/{routineId}/portable
PUT  /api/v1/agents/{agentId}/routines/{routineId}/portable
POST /api/v1/agents/{agentId}/routines/portable
POST /api/v1/routines/portable/canonicalize
```

`GET` returns an existing routine as canonical portable markdown.

`PUT` updates an existing draft routine from portable markdown. It reuses the
structured routine update path. It is only for draft routines.

`POST /agents/{agentId}/routines/portable` creates a draft routine from portable
markdown and returns:

```json
{
  "routineId": "55555555-5555-4555-8555-000000000001",
  "grammarVersion": 1,
  "content": "..."
}
```

`POST /routines/portable/canonicalize` parses and serializes markdown without
creating or updating a routine. Use it before committing a routine file.

## File Workflow

For files-in-repo workflows, use canonicalization as the commit-back step.

1. Edit the `.routine.md` file.
2. Call `POST /api/v1/routines/portable/canonicalize`.
3. If it returns `200`, write the returned `content` back to the file.
4. Commit that canonical content.
5. Send the same envelope to `POST /api/v1/agents/{agentId}/routines/portable`
   or `PUT /api/v1/agents/{agentId}/routines/{routineId}/portable`.

Canonicalization stabilizes formatting and defaults. It does not prove the
routine is semantically valid. Create and update still run routine validation.

## Errors

Grammar errors return `400` with parse diagnostics:

```json
{
  "diagnostics": [
    {
      "line": 4,
      "code": "unsupported_grammar_version",
      "message": "Unsupported routine grammar version: 2"
    }
  ]
}
```

Validation errors return `422` with the normal routine validation response. Use
this distinction to decide whether to fix the text syntax or the routine graph.

- `400` means the markdown cannot be parsed as portable routine markdown.
- `422` means the markdown parsed, but the resulting routine definition is
  invalid.

Authentication and lookup failures use the same `401` and `404` shapes as the
structured routine endpoints.

## Structured Fields Outside Markdown

Portable markdown v1 covers the routine body, activation name, trigger, reentry,
priority, slots, steps, transitions, terminals expressed in the body, skill
bindings, actions, guards, jumps, and approval/decision gates.

Some host-carried fields are not markdown tokens in v1. Completion export and
default terminal message editor fields should be managed through the structured
routine definition or the dashboard until a later grammar version adds explicit
syntax.

See [Portable Routine Markdown](./portable-routine-markdown.md) for the grammar.
