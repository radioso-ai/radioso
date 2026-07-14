---
title: "Portable Routine Markdown"
description: "The normative markdown format for deterministic routine authoring and API round trips."
last_updated: 2026-07-14
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
export: complete,handoff -> 55555555-5555-4555-8555-555555555555
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
  `once` is accepted as an alias for `once_per_conversation`. Omitted means
  `once_per_conversation`.
- `priority` - integer activation priority. Omitted means `0`.
- `export` - completion export configuration. Omitted means no markdown-level
  completion export. The syntax is
  `<triggerKinds> -> <destinationRef>`, where `triggerKinds` is `complete`,
  `handoff`, or both separated by commas.

Valid variable types are `text`, `number`, `boolean`, `email`, and `date`.
Variable keys use the same slot-key grammar as structured routines:
`[A-Za-z_][A-Za-z0-9_]*`. A declaration may use only the `optional` and
`mutable` flags, and each key may be declared once.
Unknown frontmatter keys are rejected. This reserves key names for future
grammar versions and prevents forward-compatibility drift.

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

Each `in` and `out` entry must be a `name=value` pair. Output assignments must
target a slot with `@slot_name`. The optional `mode` section accepts only
`typed` or `untyped`.

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

```md
-> end
-> end:completed ("All set.")
-> handoff
-> step:manual_review
-> step:lookup (max 3)
```

- `-> end` completes the routine at the default completion terminal.
- `-> end:name ("Message")` completes at a named completion terminal.
- `-> handoff` ends the routine by handing off to a person.
- `-> step:step_id` jumps to a titled step.
- `-> step:step_id (max 3)` is a bounded loop.

A bounded loop is its own guard kind. Do not combine `(max N)` with `[if ...]`,
`[outcome ...]`, or `[filled ...]` on the same branch line.

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
escaped. Decision options do not need route targets. Approval options do.

## Completion Export

Routine completion export is encoded in frontmatter with `export`.

```md
---
grammar: 1
name: Export results
trigger: when the routine finishes
export: complete,handoff -> 55555555-5555-4555-8555-555555555555
---
Finish the request.
```

The trigger list controls which terminal kinds emit an export. Valid trigger
kinds are `complete` and `handoff`. `destinationRef` is the raw
workspace-scoped destination UUID in grammar v1.

The serializer emits `export` only when `completionExport.enabled` is true.
When an API caller updates an existing routine through `PUT .../portable` and
the document omits `export`, the API preserves the existing structured
`completionExport` value. When the document includes `export`, that value
replaces the existing structured value.

## Canonical Form

Canonicalization parses the document and serializes it again. A conforming
serializer writes this exact order:

1. Opening fence `---`
2. `grammar: 1`
3. `name: <name>`
4. `trigger: <trigger>`
5. `reentry: <mode>`, only when the mode is not `once_per_conversation`
6. `priority: <integer>`, only when the value is not `0`
7. `export: <triggerKinds> -> <destinationRef>`, only when completion export is
   enabled
8. `vars: <declarations>`, only when declarations are needed
9. Closing fence `---`
10. One routine paragraph per line

Canonical output uses `\n` line endings, no blank line between frontmatter and
the body, and exactly one trailing newline.

Canonicalization also normalizes these details:

- variable declarations use `key:type[:optional][:mutable]`
- simple required `text` variables are elided from `vars` only when the body
  references them as a bare `@key`
- declared variables that are not referenced in the body are always emitted in
  `vars`, including simple required `text` variables
- skill binding suffixes are ordered as `in`, then `out`, then non-default
  `mode`
- branch targets are written as `end`, `handoff`, or `step:<id>`
- branch lines use exactly one space before `->`
- quoted action ids, approval labels, approval descriptions, and named
  completion messages escape quotes and backslashes

For example, a document with `vars: tracking_id:text` and no `@tracking_id`
reference keeps `vars: tracking_id:text` in canonical output. Dropping it would
lose the declared slot.

Canonicalization does not run semantic validation. A document can be grammatically
valid and still fail routine validation because of an unreachable step, missing
terminal, dangling jump, or invalid routine shape.

## Error Catalog

All parse diagnostics include `line`, `code`, and `message`.

- `unsupported_grammar_version`
  - Trigger: `grammar` is present and is not integer `1`.
  - Message: `Unsupported routine grammar version: <version>`
- `invalid_reentry`
  - Trigger: `reentry` is not `once`, `once_per_conversation`, `always`, or
    `semantic`.
  - Message: `Unsupported routine reentry mode: <value>`
- `invalid_priority`
  - Trigger: `priority` is present and is not an integer.
  - Message: `Routine priority must be an integer: <value>`
- `unknown_frontmatter_key`
  - Trigger: a frontmatter key is not one of the grammar v1 keys.
  - Message: `Unknown routine frontmatter key: <key>`
- `unknown_bracket_token`
  - Trigger: a bracket token in a routine body is not a recognized grammar v1
    token.
  - Message: `Unknown routine bracket token: <token>`
- `invalid_export`
  - Trigger: `export` does not match
    `<triggerKinds> -> <destinationRef>`, uses a trigger kind other than
    `complete` or `handoff`, or omits the destination.
  - Message: `Routine export must be "<triggerKinds> -> <destinationRef>" with trigger kinds complete and/or handoff`
- `invalid_var_declaration`
  - Trigger: a `vars` declaration has an invalid slot key, unknown slot type, or
    flag other than `optional` or `mutable`.
  - Message: `Invalid vars declaration "<declaration>": <reason>`
- `duplicate_var_declaration`
  - Trigger: a `vars` line declares the same slot key more than once.
  - Message: `Duplicate vars declaration for "<key>"`
- `invalid_guard_token`
  - Trigger: a recognized guard token (`[if ...]`, `[outcome ...]`, or
    `[filled ...]`) is present but its body does not match the grammar.
  - Message: `Invalid guard token: <token>`
- `invalid_action_token`
  - Trigger: `[action ...]` is present but the body is empty or is not a valid
    bare or quoted action id.
  - Message: `Invalid action token: <token>`
- `invalid_gate_token`
  - Trigger: `[decision ...]` or `[approval ...]` is present but the body does
    not match the gate grammar, has no options, or an approval option omits its
    route target.
  - Message: `Invalid gate token: <token>`
- `invalid_skill_binding_suffix`
  - Trigger: a skill binding suffix is present but a section is unknown,
    malformed, or has an invalid `mode`, input binding, or output assignment.
  - Message: `Invalid skill binding suffix for "#<skill>": [<suffix>]`
- `conflicting_guard_and_counter`
  - Trigger: a branch line combines a guard token with `-> step:<id> (max N)`.
  - Message: `Branch line combines a guard token with a counter limit; use "-> step:<id> (max N)" without another guard for a bounded loop`

## Versioning

The current version is grammar `1`. The serializer always emits it.

Parsers treat a missing version as version 1 so older copied documents still
parse. They do not guess newer formats. Unsupported versions return a typed
diagnostic and no partial document.
