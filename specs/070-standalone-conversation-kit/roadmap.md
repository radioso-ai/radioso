# Extraction Roadmap: Standalone Conversation Kit

**Created**: 2026-06-03
**Status**: Proposed (program roadmap; each phase spins out its own Speckit feature)
**Input**: "Make Radioso's conversation engine as generic as possible so we could export it as a stand-alone kit — what is preventing us today?"

This is a **program roadmap**, not a single feature spec. It defines the target
package topology, a concrete module-move map, and a sequenced set of phases.
Each phase is a candidate Speckit feature (suggested numbers 070–076); run the
normal `/speckit` flow on each when it is picked up.

---

## 1. Where we are

We have already done the tasteful, hard part:

- `packages/conversation-contract/` (`@radioso/conversation-contract`) — pure,
  zero-dependency vocabulary: agents, input events, directives, steering,
  skills, staged context, selection, outcomes, traces, routines, and the
  `ConversationEngine` port plus every collaborator port.
- `packages/conversation-engine/` (`@radioso/conversation-engine`) — the pure
  turn loop (`DefaultConversationEngine`) and `DefaultRoutineRunner`. It depends
  only on the contract. No Express, Postgres, OpenAI, or settings.

The loop itself is clean. What is missing is **everything that makes it run**.

### The core diagnosis

> A finished kit ships *batteries included* — a server, an SDK, storage, provider
> adapters, and a tool protocol, runnable on its own. Radioso ships an *empty
> socket*: a contract and a conductor loop that only comes alive when the Radioso
> backend injects Postgres, a provider, retrieval, session-prep, and the
> skill/directive/routine registries.

Two facts make this concrete in the live product:

1. **The engine's "thinking" ports are bypassed.**
   `backend/src/modules/chat/services/conversationProcessTurnInput.ts` wires:
   - `directiveMatcher.match()` → returns matches **already resolved during
     session prep** (`:67-71`),
   - `stores.loadHistory()` → returns the **already-loaded** `session.history`
     (`:56-58`),
   - `modelGateway` → `missingModelGateway` fallback (`:63`); there is **no
     `ConversationModelGateway` implementation in `backend/src/app`** at all.

   So directive matching and skill selection happen in `chatSessionPreparer`
   *before* the engine runs; the engine replays pre-computed decisions. The
   conversational intelligence a kit user wants lives on the **host** side of
   the boundary. (A kit-grade engine would own the match → tool-call → re-match
   loop itself.)

2. **The brains are merely mis-located, not entangled.** The directive matchers,
   skill registry, and routine selector/renderer/registry already implement
   contract ports and depend only on the contract + a model gateway port — they
   just live under `backend/src/modules/`. Relocating them is mostly an
   extraction, not a rewrite.

---

## 2. Target package topology

```
packages/
  conversation-contract/   @radioso/conversation-contract   (exists)  vocabulary only
  conversation-engine/     @radioso/conversation-engine      (exists)  pure loop + routine runner
  conversation-defaults/   @radioso/conversation-defaults    (NEW)     shipped port impls + in-memory stores
  conversation-tools/      @radioso/conversation-tools       (NEW)     generic tool/skill protocol (MCP/OpenAPI/local)
  conversation-kit/        @radioso/conversation-kit         (NEW)     thin HTTP server + SDK facade; host supplies the model gateway
```

**Dependency direction (must hold):**

```
contract  ◄── engine
contract  ◄── defaults        (may also import engine for the runner)
contract  ◄── tools
contract, engine, defaults, tools  ◄── kit   (assembles; host supplies the model gateway)
backend   ◄── (imports packages; never the reverse)
```

What each package **knows** / **must not know**:

| Package | Knows | Must NOT know |
|---|---|---|
| contract | shapes of a turn | any implementation, any provider, any transport |
| engine | how to sequence a turn through ports | who implements the ports; provider; storage; HTTP |
| defaults | how to match/select/render generically via the gateway port | OpenAI/Anthropic SDKs; Postgres; Radioso product content |
| tools | how to expose external functions as skills (MCP/OpenAPI/local) | which skills a product registers |
| kit | how to wire defaults+tools and a host-supplied gateway into a server/SDK | product rules; retrieval; workspace auth; billing |

---

## 3. Module-move map (`backend/` → packages)

`MOVE` = relocate behind the existing contract port; `STAY` = product, stays in
backend; `SPLIT` = generic core moves, product binding stays; `REFACTOR` = its
responsibility changes (see Phase C).

| Source in `backend/` | What it is | Destination | Disposition |
|---|---|---|---|
| `modules/directives/directiveMatcher.ts` | deterministic matcher | `conversation-defaults` | MOVE |
| `modules/directives/probabilisticDirectiveMatcher.ts` | LLM matcher (uses gateway) | `conversation-defaults` | MOVE (+ kit-owned prompt, see D2) |
| `modules/directives/compositeDirectiveMatcher.ts` | composes det+prob | `conversation-defaults` | MOVE |
| `modules/directives/directiveMatchParser.ts`, `directiveMatchPrompt.ts` | parse + prompt | `conversation-defaults` | MOVE (prompt → default, host-overridable) |
| `modules/directives/directiveCatalogRegistry.ts` | registry mechanics | `conversation-defaults` | MOVE |
| `modules/directives/directiveSteeringService.ts` | pre-engine orchestration | backend | REFACTOR (its matching job moves into the engine path — Phase C) |
| `modules/directives/defaultAnswerDirectives.ts` | Radioso answer directives (content) | backend | STAY (product content) |
| `modules/directives/{domain,public,composition}.ts`, `README.md` | module wiring/adapter | backend | STAY (thin; imports from package) |
| `modules/skills/skillCatalogRegistry.ts`, `skillExecutorRegistry.ts`, `skillRunResolver.ts` | registry mechanics | `conversation-defaults` | MOVE |
| `modules/skills/skillCatalogService.ts` | service wrapper | backend | STAY (thin) |
| `modules/skills/defaultCatalog.ts` | Radioso catalog content | backend | STAY (product) |
| `modules/skills/definitions/*` (`retrieval.answer`, `documents.*`, `social_only`, `assistant_identity`, `mcp.describe_capabilities`) | concrete skills | backend | STAY (product capabilities) |
| `chat/services/routines/routineRegistry.ts` | registry mechanics | `conversation-defaults` | MOVE |
| `chat/services/routines/routineNextStepSelector.ts` | LLM next-step selector | `conversation-defaults` | MOVE (+ kit-owned prompt) |
| `chat/services/routines/routineStepRenderer.ts` | step renderer | `conversation-defaults` / backend | SPLIT (generic gateway renderer moves; Radioso-composer renderer stays) |
| `chat/services/turnSelectionStrategy.ts`, `turnSkillSelector.ts` | skill selection | `conversation-defaults` / backend | SPLIT (default strategy moves; Radioso-specific stays) |
| `chat/services/conversationProcessTurnInput.ts`, `conversationContractMappers.ts`, `conversationEngineChatTurn.ts` | Radioso↔contract glue | backend | STAY (product adapter layer) |
| `chat/services/chatSessionPreparer.ts` | workspace auth, Postgres, retrieval prep | backend | STAY, but stop pre-resolving directives/selection (Phase C) |
| composers (`assistantReplyComposer.ts`, `groundedAnswerPromptComposer.ts`, `fallbackReplyComposer.ts`, …) | reply presentation | backend | STAY (product presentation) |

**Net-new (nothing to move):**

- `conversation-defaults`: in-memory `ConversationStores` + `ConversationRoutineStore`.
- `conversation-tools`: `ToolService`-style port + MCP / OpenAPI / local-function adapters.
- `conversation-kit`: HTTP server + SDK facade + in-memory wiring with a host-supplied model gateway.

**Explicit non-goals (these never leave Radioso):** retrieval pipeline, workspace
auth, billing/usage, audit, dashboard settings, document worker, and all
product-specific prompt *content* and presentation. Retrieval stays "a skill,"
not part of the kit.

---

## 4. Sequenced phases

Each phase is independently shippable (PR-per-slice, matching 066–069). The first
three are extraction/enablement and behavior-preserving for Radioso; the rest are
additive packages.

### Phase A — `conversation-defaults` (relocate the brains) · spec 070
**Goal:** Move every MOVE-marked module behind its existing contract port into a
new `@radioso/conversation-defaults` package; ship in-memory `ConversationStores`
and `ConversationRoutineStore`. Backend imports them from the package instead of
local modules.
**Behavior:** None changed for Radioso (extraction-only). Per CLAUDE.md, land the
relocation separately from any behavior change; write characterization tests for
the matchers/selectors first, then move.
**Design check:** defaults depends only on contract (+ engine for the runner);
zero backend imports; no provider SDK.
**Exit:** backend green; `conversation-defaults` builds and tests in isolation; an
in-memory store can drive `DefaultConversationEngine` in a package-level test with
no Postgres.

### Phase B — Host-supplied `ConversationModelGateway` · spec 071
**Goal:** The host implements `ConversationModelGateway` and passes it in, so every
provider SDK stays in host code.
**Decision surfaced:** Radioso's reply is generated by its renderer registry, not
the gateway. Keep it that way initially — the gateway powers the *kit's* default
composer and the matchers/selectors, not Radioso's product composer. Revisit
unifying them only if it pays for itself.
**Exit:** a package test completes a turn end-to-end against a mock/recorded
provider; Radioso unchanged.

### Phase C — Locus of control (the deep one) · spec 072
**Goal:** Make matching and selection *run in the engine path* instead of being
pre-resolved in `chatSessionPreparer`. Wire the real `DefaultDirectiveMatcher`
and default selector (from Phase A) through `conversationProcessTurnInput.ts`
rather than the pass-through closures at `:67-71`/`:56-58`.
**Why it matters:** this is the line between exporting a *conductor* (replays
host decisions) and exporting an *assistant* (decides for itself) — a true engine
vs. a pluggable loop. It also exercises engine code paths the product
currently skips.
**Constraint:** behavior-preserving for Radioso — same answers, same traces — but
now produced through the engine's ports. Guard with the existing turn-trace
audit comparison.
**Exit:** Radioso turns are byte-stable in trace shape; the kit can run a turn
with no session-prep at all.

> **Milestone M1 — "Embeddable" (after A–C):** the engine + defaults + nlp run a
> full turn from injected ports, with no Postgres and no Radioso backend. This is
> a library-grade kit.

### Phase D — `conversation-tools` (pluggable capabilities) · spec 073
**Goal:** A generic tool/skill protocol so external functions register as skills
without product code: a `ToolService`-style port plus **MCP client**, OpenAPI,
and local-function adapters. (Reuse our existing MCP work; this is the
*ingestion* side, distinct from `packages/radioso-mcp-server`.)
**Capability:** external tools/functions register as skills without product code.
**Exit:** a tool defined via MCP is dispatchable by the engine as a skill in a
package test.

### Phase E — `conversation-kit` (make it runnable) · spec 074
**Goal:** A thin HTTP server + SDK facade + CLI that wires defaults + nlp + tools
with in-memory stores — the runnable "hello world": define an agent + a directive
in a few lines, POST a message, get a grounded reply.
**Design check:** kit assembles only; it owns no domain logic. No Radioso imports.
**Exit:** `npx @radioso/conversation-kit` (or equivalent) serves a turn locally
with only a provider key.

> **Milestone M2 — "Runnable" (after D–E):** install, define behavior, hit an
> endpoint — a self-contained product surface.

### Phase F — Portable authoring + persistence · spec 075
**Goal:** A swappable persistence port for agents/directives/routines (transient
+ one reference durable adapter) and a CRUD authoring surface, so behavior is
defined through the kit rather than backend registries. Glossary / canned
responses / context variables can follow here if we want them.

### Phase G — Evaluation / coherence (the prestige feature) · spec 076
**Goal:** Directive coherence/contradiction checks before a directive is
accepted — "you can't deploy a directive that contradicts an existing one."
This is the behavioral-guarantee layer that sets the kit apart.

> **Milestone M3 — "Self-serve" (after F–G):** authoring API, swappable
> persistence, and behavioral guarantees.

---

## 5. Capability scorecard

| Target capability | Radioso today | Closed by |
|---|---|---|
| Pure turn engine | ✅ `conversation-engine` | — |
| Clean contracts | ✅ `conversation-contract` | — |
| Shipped default port impls | ❌ in `backend/` | Phase A |
| Provider abstraction + adapters | ❌ port only, vestigial | Phase B |
| Engine owns matching/selection | ❌ pre-resolved in session prep | Phase C |
| Tool service (MCP/OpenAPI/local) | ❌ bespoke skills in backend | Phase D |
| Server + SDK + CLI | ❌ fused to Express/auth/Postgres | Phase E |
| Swappable persistence + authoring API | ❌ Postgres + backend registries | Phase F |
| Evaluation / coherence guarantees | ❌ none | Phase G |
| Glossary, canned responses, context vars, customers | ❌ not modeled | Phase F+ (optional) |

A–C alone gets a demoable, embeddable kit. D–E make it a runnable product. F–G
reach the self-serve milestone.

---

## 6. Open decisions

- **D1 — One `conversation-defaults` package or split (`-skills`, `-directives`,
  `-routines`)?** Start with one cohesive `defaults` package; split only if a
  consumer wants directives without routines. (Avoid premature package sprawl —
  high file/package count is a smell.)
- **D2 — Where do the matcher/selector/renderer prompts live?** Today runtime
  prompts live under `backend/prompts/` (CLAUDE.md). A standalone package can't
  reach them. Decision: `conversation-defaults` ships its **own default prompt
  templates**, and exposes a host-override hook so Radioso keeps authoring its
  prompts under `backend/prompts/`. This preserves the CLAUDE.md rule for the
  product while making the package self-contained.
- **D3 — Does Radioso's product composer move onto the gateway?** Recommend *no*
  initially (Phase B note). The gateway powers the kit's default composer +
  matchers; Radioso keeps its renderer registry. Unify later only if justified.
- **D4 — Session/event model ownership.** The contract has `ConversationEvent`
  and a `ConversationStores` port but no durable session entity. Phase F decides
  whether the kit ships a portable session/event store or leaves it to hosts.
- **D5 — Naming/publication.** Packages are `private: true` and `workspace:*`
  today. Publishing as a kit needs a public scope, build outputs, and a license
  decision (note the EE boundary).

---

## 7. Suggested first step

Open spec **070** for Phase A (`conversation-defaults`) as an extraction-only
change: characterization tests for the directive matchers, skill registry, and
routine selectors first, then relocate behind the existing ports, then ship the
in-memory stores. It is the lowest-risk, highest-leverage move — it turns the
"empty socket" into a package with batteries without touching product behavior,
and it makes Phase C (locus of control) a wiring change rather than a rewrite.
