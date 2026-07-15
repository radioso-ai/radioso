# Data Model: Portable Agent Authoring — US1

No database entities change. `RoutineDefinition` remains the data of record,
persisted exactly as today. The model additions are package-level types and one
HTTP envelope.

## Package layering

```
@radioso/routine-definition          @radioso/routine-markdown
  limits, enums                        GRAMMAR_VERSION = 1
  routine*Schema (Zod)          <───   parse(content) → { doc | diagnostics }
  RoutineDefinition,                   serialize(doc) → content (canonical)
  RoutineDefinitionDraftInput,         canonicalize(content) → content | diagnostics
  RoutineInputBinding (incl.           docToDraftInput(doc) ⇄ draftToDoc(draft)
    contextVariableRef), ...           ParseDiagnostic { line, column?, code, message }
        ▲            ▲                        ▲
        │            │                        │
  backend modules/routines        frontend routine-prose.ts (chip layer)
  (domain.ts = re-export shim)    backend modules/routines/portableDocument.ts
```

Dependency direction: `routine-markdown` → `routine-definition` → (zod only).
Nothing in either package may import backend, frontend, Express, React, or a
model provider.

## Portable document envelope (HTTP, JSON)

```ts
// request/response body for portable sub-resource
{
  grammarVersion: number,   // response: always GRAMMAR_VERSION; request: must be supported
  content: string           // the markdown document; response is always canonical form
}
```

- `GET  /agents/{agentId}/routines/{routineId}/portable` → 200 envelope
- `PUT  /agents/{agentId}/routines/{routineId}/portable` → 200 envelope (canonical, ids injected)
- `POST /agents/{agentId}/routines/portable` → 201 { routineId, grammarVersion, content }
- `POST /routines/portable/canonicalize` → 200 envelope (no persistence)

Errors:
- 400 `{ diagnostics: ParseDiagnostic[] }` — grammar violations (line/token level)
- 422 existing routine validation response — semantically invalid definition
- 409/404 semantics inherited from the structured endpoints

## Grammar frontmatter additions

```
---
grammar: 1            # NEW — self-declared version; missing ⇒ 1; unsupported ⇒ diagnostic
name: Greeter
trigger: When ...
vars: amount:number, email:email:optional
---
```

Binding token gains a third kind (FR-004):

```
#order_lookup[in email=@email, region=ctx.page_locale; out status=@order_status]
                              └── contextVariableRef binding: ctx.<variableName>
```

(exact token spelling to be settled in the package with round-trip tests; must be
unambiguous vs `@var` and literals, and must survive doc⇄draft⇄doc.)

## Chip-document layer (frontend-local, FR-004a)

`ChipDocVariable`/binding chips gain a `contextVariableRef` representation so an
API-authored binding renders as a preserved chip and survives open→edit→save.
No new editing affordance is required beyond preservation + display.

## State transitions

Unchanged. Portable PUT/POST reuse the existing draft→validate→publish lifecycle
paths; markdown intake produces the same `RoutineDefinitionDraftInput` the
structured intake produces, upstream of all lifecycle logic.
