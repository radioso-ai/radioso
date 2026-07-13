---
title: "Portable Routine Markdown"
description: "The normative markdown format for deterministic routine authoring and API round trips."
last_updated: 2026-07-13
---

# Portable Routine Markdown

Portable routine markdown is the deterministic text form for a routine definition.
The parser in `@radioso/routine-markdown` is the contract. The dashboard prose
editor and the portable routine API use the same parser and serializer.

This is not the `draft-assist` prose feature. Portable markdown is parsed without
an LLM call.

## Document Shape

A complete document starts with YAML-like frontmatter, followed by one routine
line per paragraph.

```md
---
grammar: 1
name: Refund check
trigger: customer asks for a refund
reentry: once_per_conversation
priority: 20
vars: order_id:text, amount:number:optional
---
Ask for @order_id.
# Check eligibility
Call the refund tool #refund.check[in order=@order_id, locale=ctx.page_locale; out status=@refund_status]
[if refund_status = approved] -> end
[outcome failed] -> handoff
```

`grammar: 1` is the current grammar version. A missing grammar key is parsed as
version 1. An unsupported version is rejected with an
`unsupported_grammar_version` diagnostic.

## Frontmatter

The frontmatter keys are:

- `grammar` - integer grammar version. The serializer always emits `1`.
- `name` - routine display name. Missing parses as an empty name.
- `trigger` - activation trigger description. Missing parses as an empty trigger.
- `vars` - comma-separated slot declarations. Each item is
  `key:type[:optional][:mutable]`.
- `reentry` - one of `once_per_conversation`, `always`, or `semantic`.
  Omitted means `once_per_conversation`.
- `priority` - integer activation priority. Omitted means `0`.

Valid variable types are `text`, `number`, `boolean`, `email`, and `date`.

Canonical serialization keeps frontmatter minimal. It emits `vars` only for
referenced variables whose declaration cannot be recovered from a bare token:
non-`text` variables, optional variables, or mutable variables. A referenced
required `text` variable can be written as `@name` with no `vars` entry.

## Inline Tokens

Variables use `@name`. In the compiled routine they become slot references in
step instructions.

Skills use `#skill_name`. A skill can carry typed input bindings and output
assignments in a suffix:

```md
#crm.lookup[in email=@email, locale=ctx.page_locale, tier=gold; out account_id=@account_id]
```

Input bindings are:

- `input=value` - literal string, number, or boolean
- `input=@slot_name` - a routine variable reference
- `input=ctx.context_name` - a context variable reference

The `ctx.<name>` binding is preserved by the parser, serializer, and dashboard
chip editor. The editor may render it as read-only; saving must not rewrite it as
a literal or slot reference.

Actions use `[action type]`, or `[action "type with spaces"]` when quoting is
needed.

Step headings use `# Title`. The title pins a stable step id after slugification.
Following non-heading lines belong to that titled step until the next heading.

## Guards

A branch line can start with a guard token.

Field guards:

```md
[if amount >= 100] -> handoff
[if country in US, CA] -> step:manual_review
[if order_date older than 30 days] -> end
[if email is present] -> step:lookup
```

Supported operators are `=`, `!=`, `in`, `>`, `>=`, `<`, `<=`, `is true`,
`is false`, `is present`, `is absent`, `older than`, and `within`.
Relative-date guards use `days`, `weeks`, `months`, or `years`.

Skill outcome guards use:

```md
[outcome failed] -> handoff
```

Slot-filled guards use:

```md
[filled @email, @order_id] -> step:lookup
```

A branch line without a deterministic guard is an LLM guard. Its prose becomes
the `guardText` that the runtime asks the model to judge.

## Jumps And Terminals

Targets are written after `->`.

- `-> end` completes the routine at the default completion terminal.
- `-> end:name ("Message")` completes at a named completion terminal.
- `-> handoff` ends the routine by handing off to a person.
- `-> step:step_id` jumps to a titled step.
- `-> step:step_id (max 3)` is a bounded loop.

The serializer writes terminal ids and named completion messages that are present
in the chip document. Completion and handoff settings outside the body, such as
the default completion message and handoff message fields in the dashboard, are
host-carried fields, not markdown tokens.

## Decision And Approval Gates

Inline decision gates use:

```md
[decision refund_decision: approve="Approve", deny="Deny"]
```

Approval gates use the same option syntax and include route targets:

```md
[approval refund_decision: approve="Approve" -> end, deny="Deny" ("Needs review") -> handoff]
```

Labels and descriptions are quoted. Quotes and backslashes inside them are
escaped.

## Completion Export

Routine completion export is part of the routine definition, but it is not encoded
as a markdown token in grammar v1. Hosts that edit a routine through the chip
document carry completion export alongside the body. File-based portable-routine
API users should treat completion export as structured routine configuration,
not as part of the markdown body, until a later grammar version adds a token.

## Canonical Form

Canonicalization parses the document and serializes it again. It normalizes:

- frontmatter order and the emitted `grammar: 1` key
- default elision for `reentry`, `priority`, and simple text variables
- variable declarations to `key:type[:optional][:mutable]`
- skill binding suffix order: `in`, then `out`, then non-default `mode`
- targets as `end`, `handoff`, or `step:<id>`
- quoted action ids, approval labels, and approval descriptions

Canonicalization does not run semantic validation. A document can be grammatically
valid and still fail routine validation because of an unreachable step, missing
terminal, dangling jump, or invalid routine shape.

## Versioning

The current version is grammar `1`. The serializer always emits it.

Parsers treat a missing version as version 1 so older copied documents still
parse. They do not guess newer formats. Unsupported versions return a typed
diagnostic and no partial document.
