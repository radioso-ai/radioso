# Research: Continuous Content Planning

## Turn-time registration and durability

- **Decision**: inject a capability-neutral `CommittedAssistantTurnObservationWriter`
  into `PostgresAssistantTurnPersistence` and register eligible/unresolved semantic
  contributions inside the existing assistant-message transaction. The write is
  idempotent and contains no provider call, clustering, or enrichment. A replayable
  Quality-owned cursor performs bounded historical bootstrap and rolling repair.
- **Rationale**: the transaction already commits assistant message, routine/action/
  clarification state, conversation touch, and audit together. It is the only point
  holding assistant ID, immutable grounding snapshot, lifecycle outcome, canonical
  semantic intents, and reusable vectors at once. Atomic registration preserves the
  “almost free” vector reuse and cannot silently lose a pending observation after a
  process crash. The repair cursor protects historical/rolling-deploy gaps without
  becoming the normal delivery path.
- **Alternatives considered**: a post-commit callback can lose observations and
  vectors; registering at user-message creation counts failed/unanswered turns; a
  periodic report scan recreates traffic spikes and loses turn-time vectors.

## Capability-neutral turn understanding

- **Decision**: add `ConversationInteractionRole` with exactly
  `substantive_new`, `substantive_followup`, `clarification_value`, `control`,
  `social`, and `unresolved` to the conversation contract. Fused turn planning and
  staged interpretation emit the same strict field and contextual intent. Chat
  lifecycle facts override the inferred role: a resolved pending clarification is a
  clarification value, an active routine/pending-decision value is control, and a
  social terminal path is social. Malformed role output becomes unresolved.
- **Rationale**: one multilingual structured decision already has the necessary
  context. Lifecycle state is more authoritative than model inference. The neutral
  contract is useful beyond reporting and keeps Chat unaware of topic policy.
- **Alternatives considered**: regex/keyword filtering is English-specific; a second
  report-only classifier adds latency/cost and can disagree with retrieval; treating
  every retrieval route as a new question creates “yes” and clarification-value topics.

## Clarifications and contextual follow-ups

- **Decision**: a substantive follow-up uses retrieval’s standalone semantic query.
  A resolved clarification value may finalize one observation tied to the earlier
  originating user turn; it never adds demand for the value message itself. Chat
  resolves that source from the pending clarification/history seam and passes the
  source ID in the neutral committed-turn envelope. Unresolved observations wait no
  longer than the next resolving turn, then become excluded with a typed reason.
- **Rationale**: source identity—not wording—is what prevents double counting. The
  canonical semantic intent already reflects the completed question.
- **Alternatives considered**: assigning “Okta” directly creates a false topic;
  mutating an existing aggregate without source membership is not replayable.

## Reusable semantic vector envelopes

- **Decision**: Retrieval exposes internal `SemanticVectorEnvelope` values for every
  distinct semantic query actually embedded and searched, including opaque
  `EmbeddingSpaceRef`. Deterministic retrieval maps its current per-query embedding
  map; agentic semantic-search tooling collects the same envelope. Lexical-only,
  capped, failed, and non-retrieval intents have no envelope and enter
  `pending_embedding`.
- **Rationale**: the vectors already exist but the deterministic stage currently drops
  all except the first and drops the space; the agentic path drops all. Exposing a
  consumer-neutral internal result preserves exact retrieval behavior and avoids a
  second rewrite or embedding request.
- **Alternatives considered**: storing only `activeEmbedding` mishandles multi-intent
  turns; copying full vectors into message JSON is large and unqueryable; Content
  Planning calling Retrieval internals reverses the dependency.

## Missing-vector fallback

- **Decision**: the observation stores only semantic hash/source IDs. The async worker
  reloads the canonical intent from message-owned structured turn metadata or legacy
  audit retrieval metadata, validates its hash, batches it through the clustering
  embedding port bound to the active space, then stores the vector. Historical rows
  lacking a canonical contextual intent use bounded conversation-aware bootstrap
  interpretation; ambiguous fragments are excluded rather than raw-embedded.
- **Rationale**: this avoids durable duplication of visitor questions in the
  projection while retaining an auditable source. Source deletion immediately removes
  the text and cascades observation state.
- **Alternatives considered**: retaining a second raw/derived text copy complicates
  deletion; blindly embedding raw fragments corrupts clustering.

## Projection generations and embedding-space handoff

- **Decision**: one workspace state points to a coherent projection generation and,
  during bootstrap/reprojection, an optional target generation. Vectors and
  memberships are per generation/space. Reads remain on the coherent generation until
  the target has processed the eligible horizon and passes consistency checks; the
  pointer then changes atomically.
- **Rationale**: incompatible vectors never meet and the operator keeps a complete
  prior view while rebuilding.
- **Alternatives considered**: overwriting centroids in place creates mixed-space
  comparisons and partial totals; hiding the page during reprojection sacrifices useful evidence.

## Incremental assignment, maturity, and merge rules

- **Decision**: policy version 1 uses cosine similarity against active topic centroids,
  with a nearest-topic floor of `0.82` and a representative-member cohesion floor of
  `0.76`. Non-matches form provisional topics. A topic matures at two coherent
  observations from two distinct conversations. Reconciliation may merge when
  centroid similarity is at least `0.90` and cross-representative cohesion is at least
  `0.82`. Automatic splits are disabled. Zero-member provisional topics retire;
  merged redirects remain at least 90 days.
- **Rationale**: conservative thresholds resist broad clusters and make the approved
  maturity rule explicit. Both nearest-centroid and representative cohesion avoid the
  chaining failure of centroid-only assignment. Values are versioned and must meet the
  committed multilingual fixture before release; fixture evidence may tighten them
  without changing the contract version.
- **Alternatives considered**: online k-means forces every point into a cluster;
  DBSCAN/full rebuild violates incremental operation; centroid-only matching admits outliers.

## Rolling windows and authoritative counts

- **Decision**: freeze `asOf` at request start. Current is `[asOf-30d, asOf)` and
  comparison `[asOf-60d, asOf-30d)`, using complete UTC instants. Membership is
  durable, but demand, grounding, active remediation, and summary totals are computed
  from live source observations plus the Quality evidence port. Cursor payloads freeze
  `asOf`, view, ranking version, projection generation, and ordering tuple.
- **Rationale**: live joins make aging, deletion, triage, and Eval verification
  reconcile without rewriting cached topic counters, while a frozen cursor prevents
  page drift.
- **Alternatives considered**: mutable cached totals become incorrect; label-based
  cursors break when enrichment changes.

## Quality evidence boundary

- **Decision**: add a focused Quality-owned content-planning evidence source. It pages
  the canonical turn population for bootstrap, batch-hydrates grounding/effective
  triage/Eval evidence, and maps bounded member pages through the existing
  `LowQualityTurn` representation. Content Planning consumes the port but owns joins
  to its memberships and all report semantics.
- **Rationale**: operator-test and human-authored exclusions, effective triage after a
  newer thumbs-down, and passing Eval verification are subtle and already Quality-owned.
- **Alternatives considered**: copying `turnPopulationSql.ts` causes count drift;
  expanding `QualityTurnsService` into a projection orchestrator violates its boundary.

## Trend, evidence, opportunity, and ordering policy v1

- **Decision**:
  - evidence band uses evaluated distinct conversations: `none=0`, `low=1..4`,
    `medium=5..19`, `high>=20`;
  - credible active gap requires a mature topic and at least two distinct current-window
    conversations with active degraded/no-support evidence;
  - trend is `insufficient_data` when both windows total fewer than three questions;
    `new` when current has at least two and comparison is zero; otherwise `rising` or
    `falling` requires an absolute delta of at least two and a relative delta of at
    least 25%; remaining topics are `steady`;
  - opportunity order is lexicographic: active no-support conversation count,
    active degraded conversation count, current distinct-conversation demand,
    trend rank (`new`, `rising`, `steady`, `falling`, `insufficient_data`), then topic UUID.
- **Rationale**: these are deterministic, explainable, and match the approved
  denominator/ranking requirements without pretending sparse percentages are precise.
- **Alternatives considered**: a weighted opaque score is hard to explain and test;
  relative change alone overreacts to one-versus-zero samples.

## Deterministic recommendation action v1

- **Decision**: the corpus adapter returns typed evidence independent of prose.
  `monitor` applies without a credible gap. With a credible gap, successful corpus
  analysis and no related document above `0.74` yields `add_content`; relevant content
  predating the gap that was generally absent from retrieved/cited evidence yields
  `investigate_retrieval`; content retrieved but insufficient, or changed after the
  gap, yields `review_existing_content`. Unavailable corpus analysis yields no action.
- **Rationale**: an action is a domain decision. A generated brief may explain it but
  cannot choose it.
- **Alternatives considered**: allowing the LLM to select actions makes identical
  evidence nondeterministic; defaulting provider failure to add-content creates duplicates.

## Enrichment scheduling and safety

- **Decision**: enrichment becomes dirty on first maturity, action/corpus change,
  grounding-band change, or membership growth of at least 20%/five observations since
  the last enriched revision. It is debounced for five minutes, claimed with a lease,
  bounded to the ten highest-ranked credible opportunities for briefs, and published
  only if the source topic revision still matches. Prompts delimit at most eight
  authorized representative questions as untrusted data; strict Zod output has no
  tools. The brief contains questions/scope, not business answers.
- **Rationale**: material-change triggers avoid one model call per message and revision
  fences prevent stale prose. Bounded representative evidence contains injection risk.
- **Alternatives considered**: enriching every assignment is expensive and spiky;
  caching provider responses outside source/deletion state can leak deleted content.

## Worker and retry model

- **Decision**: `ContentPlanningWorker` runs only in `startWorkerRuntime.ts`, polls
  PostgreSQL, and claims bounded work with `FOR UPDATE SKIP LOCKED`. Embedding,
  assignment, reconciliation, and enrichment use typed stages, exponential bounded
  retries, leases, and terminal safe reason codes. Bootstrap/reprojection use per-
  workspace daily request and estimated-spend counters under budget policy version 1;
  exhaustion moves to `budget_paused` and resumes on the next budget window.
- **Rationale**: it matches existing action/vector work patterns and spreads load
  continuously. General application-module initialization runs in API/crawler/task
  runtimes and therefore must not start this poller.
- **Alternatives considered**: AMQP/document jobs introduce an unrelated cross-service
  contract; a cron/full report recreates spikes.

## API and frontend route shape

- **Decision**: mount three reads at `/api/v1/quality/content-plan`. Use opaque
  keyset cursors, bounded page sizes, typed canonical redirect metadata, and the
  existing Quality turn DTO for member turns. Dashboard routes are
  `/w/:workspaceKey/content-plan`, `/content-plan?view=all_interests`, and
  `/content-plan/topics/:topicId`. Quality/Knowledge handoffs carry topic IDs only;
  brief text never enters a URL.
- **Rationale**: Content plan remains visibly under Activity while retaining a stable
  direct URL. The list contract renders the whole first view without N+1 topic calls.
- **Alternatives considered**: an Activity query-only route makes shared detail URLs
  brittle; a report job/refresh endpoint contradicts continuous projection.

## Message queue impact

- **Decision**: no document-worker AMQP payload, document processing job kind,
  dispatcher, retry contract, queue test, or queue documentation changes.
- **Rationale**: the processor is a PostgreSQL-claimed workload in the existing
  backend worker process. Generated MCP OpenAPI types change because the HTTP surface
  changes, but no MCP tool is added.

## Observability

- **Decision**: add a Content Planning observability facade. Logs and traces use safe
  workspace/observation/topic/job IDs, typed stage/outcome/reason, counts, durations,
  and revisions. Metrics use bounded labels only: stage, outcome, reason,
  vector-source, assignment outcome, lifecycle, and projection state. Reads add no
  audit event.
- **Rationale**: worker lag/retries/cost need operator support correlation, while all
  content and generated labels remain customer data.
- **Alternatives considered**: labels/hashes as metric labels are high cardinality and
  sensitive; logging provider errors can include prompts or completions.
