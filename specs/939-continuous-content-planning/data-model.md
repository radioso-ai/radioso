# Data Model: Continuous Content Planning

## Design principles

- PostgreSQL remains authoritative; topic counters are never the only source of truth.
- Raw visitor questions and contextual semantic text remain message/audit-owned.
  Projection rows retain source IDs, a SHA-256 semantic-text hash, vectors, scalar
  grounding evidence, and membership.
- Observation identity is stable across retry and projection generations.
- Vectors/memberships are generation-scoped so an old coherent embedding space and a
  new target space can coexist without comparison.
- All tenant-owned keys and lookups include `workspace_id`.
- Source deletion cascades evidence and triggers topic reconciliation; generated
  evidence is revision-fenced and cleared/staled when its source disappears.

## Content plan projection state

One row per workspace in `content_plan_projection_states`.

| Field | Type | Rules |
|---|---|---|
| workspace_id | UUID | Primary key, FK workspace, cascade delete |
| coherent_generation_id | UUID nullable | Generation served to reads; null before first coherent bootstrap |
| target_generation_id | UUID nullable | Generation currently bootstrapping/reprojecting |
| projection_state | text | `bootstrapping`, `ready`, `updating`, `delayed`, `reprojecting`, `degraded`, `budget_paused` |
| reason | text nullable | Typed safe reason code only |
| discovery_created_at | timestamptz nullable | First half of replay/bootstrap cursor |
| discovery_message_id | UUID nullable | Stable cursor tie-breaker |
| processed_through | timestamptz nullable | Newest coherently processed source time |
| bootstrap_processed / bootstrap_total | bigint nullable | Progress; both null outside bootstrap/reprojection |
| budget_version | integer | Server policy version |
| budget_window_started_at | timestamptz | Per-workspace UTC budget window |
| embedding_requests_used | integer | Bounded fallback request accounting |
| estimated_spend_micros | bigint | Provider-independent estimated spend accounting |
| lease_token / lease_expires_at | UUID / timestamptz nullable | Exclusive discovery/reconciliation lease |
| created_at / updated_at | timestamptz | Lifecycle timestamps |

Cursor advancement and observation discovery are one transaction. Pending counts are
derived from vector and enrichment states, not copied into this row.

## Projection population snapshot

`content_plan_projection_population_snapshots` freezes the assistant-message population
for one bootstrap or reprojection generation. It is a membership/control table only;
source wording stays in `messages`.

| Field | Type | Rules |
|---|---|---|
| workspace_id / generation_id | composite | Tenant scope and FK generation; generation deletion cascades |
| assistant_message_id | UUID | FK workspace message; source deletion cascades immediately |
| created_at | timestamptz | Stable replay order copied from the source message |

Primary key:

```text
(workspace_id, generation_id, assistant_message_id)
```

The projection lease captures the snapshot and initializes `bootstrap_total`
atomically. The worker keyset-pages this fixed set, so late backdated inserts cannot
change a generation's denominator or make promotion incoherent. If a snapshotted source
is deleted, the FK removes it and progress reconciles to processed plus remaining rows.
Normal committed-turn intake continues into the writable target generation.

## Projection generation

`content_plan_projection_generations` describes one coherent clustering space.

| Field | Type | Rules |
|---|---|---|
| id | UUID | Primary key |
| workspace_id | UUID | FK workspace, cascade delete |
| embedding_space_id | UUID | FK embedding space; immutable |
| kind | text | `bootstrap`, `active`, `reprojection` |
| state | text | `building`, `coherent`, `superseded`, `failed` |
| policy_version | integer | Assignment/maturity/merge policy version |
| horizon_from / horizon_to | timestamptz | Frozen generation build horizon |
| coherent_at | timestamptz nullable | Set only after consistency gate |
| created_at / updated_at | timestamptz | Lifecycle timestamps |

At most one coherent and one building generation exist per workspace. Promotion sets
the target generation coherent, updates the workspace pointer, and supersedes the old
generation atomically.

## Content planning observation

`content_plan_observations` represents one substantive semantic need or one unresolved
turn awaiting its next context.

| Field | Type | Rules |
|---|---|---|
| id | UUID | Primary key |
| workspace_id | UUID | Tenant scope |
| source_user_message_id | UUID | Composite workspace/message FK, cascade delete |
| source_assistant_message_id | UUID | Answer that completed/grounded the observation, cascade delete |
| conversation_id | UUID | Composite workspace/conversation FK, cascade delete |
| semantic_intent_id | text | Stable bounded subquery slot ID; `unresolved` for pending context |
| semantic_text_hash | text nullable | Lowercase SHA-256 hex of canonical intent; never reversible |
| interaction_role | text | Six-value `ConversationInteractionRole` |
| grounding_verdict | text nullable | `grounded`, `degraded`, `no_support`; null means not evaluated |
| grounding_claim_count | integer nullable | Immutable answer snapshot scalar |
| grounding_sourced_claim_count | integer nullable | Immutable answer snapshot scalar |
| grounding_unsourced_claim_count | integer nullable | Immutable answer snapshot scalar |
| grounding_invalid_source_count | integer nullable | Immutable answer snapshot scalar |
| resolution_deadline | timestamptz nullable | Unresolved observations expire after the next resolving turn/bounded grace |
| observation_state | text | `pending_context`, `ready`, `excluded`, `deleted` |
| excluded_reason | text nullable | Typed safe reason (`social`, `control`, `ambiguous`, `source_unavailable`, etc.) |
| observed_at | timestamptz | Assistant commit time; basis for rolling windows |
| created_at / updated_at | timestamptz | Persistence timestamps |

Unique identity:

```text
(workspace_id, source_user_message_id, semantic_intent_id)
```

One source user message can create several observations for distinct semantic
subqueries. Topic/report query counts use distinct `source_user_message_id` so duplicate
or overlapping subqueries do not inflate volume.

Social/control turns normally create no observation. `unresolved` is retained because
it may be finalized on the next turn. A clarification value that resolves an earlier
interest uses the earlier user message as `source_user_message_id` and the current
answer as `source_assistant_message_id`, so it changes evidence without creating a
second demand identity.

## Observation vector/work item

`content_plan_observation_vectors` stores one observation's state in one generation.

| Field | Type | Rules |
|---|---|---|
| workspace_id | UUID | Tenant scope |
| observation_id | UUID | FK observation, cascade delete |
| generation_id | UUID | FK projection generation, cascade delete |
| embedding_space_id | UUID | Must equal generation space |
| dimensions | integer nullable | Must match the stored vector/space |
| embedding | vector nullable | Present after reuse/fallback embedding |
| vector_source | text nullable | `reused` or `fallback` |
| state | text | `pending_embedding`, `ready`, `processing`, `assigned`, `retryable`, `failed` |
| attempt_count | integer | Bounded per typed stage |
| available_at | timestamptz | Retry/debounce ordering |
| claim_token / claimed_at / claim_expires_at | UUID/timestamptz nullable | Lease |
| failure_stage / failure_reason | text nullable | Safe enums only |
| completed_at | timestamptz nullable | Assignment completion |
| created_at / updated_at | timestamptz | Lifecycle timestamps |

Primary key:

```text
(workspace_id, observation_id, generation_id)
```

The worker never compares `embedding` across different `embedding_space_id` values.
Partial claim indexes cover pending/retryable rows ordered by `available_at`.

## Content topic

`content_plan_topics` stores one stable public topic identity in a projection generation.

| Field | Type | Rules |
|---|---|---|
| workspace_id | UUID | Tenant scope |
| generation_id | UUID | Projection generation |
| id | UUID | Stable public ID; preserved when a topic maps across generations |
| embedding_space_id | UUID | Same as generation |
| lifecycle | text | `provisional`, `mature`, `merged`, `retired` |
| centroid | vector | Incremental normalized centroid |
| dimensions | integer | Space/vector guard |
| centroid_weight | integer | Number of live contributing observations |
| representative_observation_ids | UUID[] | Bounded IDs only; no text |
| revision | integer | Increments on material evidence/membership change |
| merged_into_topic_id | UUID nullable | Same-workspace/generation survivor |
| redirect_expires_at | timestamptz nullable | At least 90 days after merge |
| enrichment_dirty_at | timestamptz nullable | Debounce input |
| created_at / updated_at | timestamptz | Lifecycle timestamps |

Primary key:

```text
(workspace_id, generation_id, id)
```

Topic IDs are not exposed for a one-member provisional item in the list; the emerging
entry uses an observation identifier/reference. Once mature, the stable topic ID is
public. Reprojection maps coherent topics to target topics conservatively and carries
the stable ID only for a verified match. Redirect resolution follows at most eight
hops, rejects cycles, scopes every hop to workspace/generation, and returns retired
zero-member provisionals as indistinguishable 404s.

## Topic membership

`content_plan_topic_memberships` is the assignment authority.

| Field | Type | Rules |
|---|---|---|
| workspace_id | UUID | Tenant scope |
| generation_id | UUID | Projection generation |
| observation_id | UUID | FK observation/vector |
| topic_id | UUID | Composite FK topic |
| assignment_version | integer | Assignment policy version |
| similarity | real | Cosine similarity in `[0,1]` |
| cohesion | real | Worst/bounded representative cohesion in `[0,1]` |
| assigned_at | timestamptz | Immutable assignment time unless reconciliation moves it |

Primary key:

```text
(workspace_id, generation_id, observation_id)
```

Indexes support `(workspace_id, generation_id, topic_id, observation_id)` and rolling
window joins through observation time. Assignment plus topic centroid/revision update
is one transaction guarded by the claimed vector token.

## Topic enrichment

`content_plan_topic_enrichments` holds only the latest publishable state per topic and
is fenced by topic revision.

| Field | Type | Rules |
|---|---|---|
| workspace_id / generation_id / topic_id | composite | Primary key/FK topic |
| source_topic_revision | integer | Output publishes only while this still matches |
| state | text | `pending`, `ready`, `stale`, `unavailable`, `outside_analysis_cap` |
| label / description | text nullable | Validated bounded operator-language output |
| suggested_title | text nullable | No factual claim |
| rationale | text nullable | Evidence-based, bounded |
| questions_to_answer | jsonb nullable | Array of 3–7 bounded strings |
| suggested_shape | text nullable | Validated enum |
| evidence_statement | text nullable | Must name sample basis |
| action | text nullable | Deterministic `add_content`, `review_existing_content`, `investigate_retrieval`, `monitor`; null if unavailable |
| action_rule_version | integer | Deterministic rule version |
| corpus_state | text | `pending`, `ready`, `unavailable`, `stale` |
| corpus_checked_at | timestamptz nullable | Invalidation basis |
| available_at / attempt_count | retry fields | Debounced, bounded |
| claim_token / claim_expires_at | lease fields | Concurrent worker safety |
| failure_stage / failure_reason | text nullable | Safe enums only |
| enriched_at / updated_at | timestamptz nullable | Freshness |

No prompt, completion, representative question, provider response, or historical
enrichment output is retained here. Failure leaves the last coherent ready fields
readable with state `stale` where safe; deletion clears source-derived prose before
re-enrichment.

## Enrichment repair cursor

`content_plan_enrichment_repair_cursors` records durable progress through mature topics
that are outside the hot dirty/frontier set.

| Field | Type | Rules |
|---|---|---|
| workspace_id / generation_id | composite | Primary key/FK generation; generation deletion cascades |
| after_topic_id | UUID nullable | Last successfully completed keyset page; null starts or wraps the scan |
| version | integer | Positive compare-and-swap revision |
| updated_at | timestamptz | Cursor freshness |

The planning source combines bounded dirty topics, the persisted opportunity frontier,
current generated-brief carriers, and one bounded repair page. Observation/evidence
hydration is independently keyset-paged. The cursor advances only after scheduling or
rebasing the selected page succeeds, so process restarts cannot silently strand a
topic and no full-report hydration is required.

## Topic-document evidence

`content_plan_topic_documents` normalizes at most five related documents per topic.

| Field | Type | Rules |
|---|---|---|
| workspace_id / generation_id / topic_id | composite | FK topic |
| document_id | UUID | Workspace document FK, cascade delete |
| source_topic_revision | integer | Corpus result fence |
| similarity | real | Possible relevance, not completeness |
| existed_before_gap | boolean | Deterministic timestamp evidence |
| retrieved_by_gap_answers | boolean | Aggregate source-turn retrieval evidence |
| cited_by_gap_answers | boolean | Aggregate source-turn citation evidence |
| changed_after_gap | boolean | Deterministic timestamp evidence |
| created_at / updated_at | timestamptz | Lifecycle timestamps |

Primary key:

```text
(workspace_id, generation_id, topic_id, document_id)
```

Document deletion removes the link and marks/clears the associated enrichment in the
same invalidation workflow. API reads hydrate only still-authorized document metadata;
no chunks or excerpts are returned.

## Corpus invalidation marker

`content_plan_corpus_invalidations` coalesces workspace document publication into one
constant-time marker instead of synchronously revising every credible topic.

| Field | Type | Rules |
|---|---|---|
| workspace_id | UUID | Primary key/FK workspace, cascade delete |
| revision | bigint | Positive monotonic publication revision |
| dirty_at | timestamptz | Latest corpus change time |
| after_generation_id / after_topic_id | UUID nullable | Both null or both present; bounded keyset cursor |
| updated_at | timestamptz | Marker lifecycle timestamp |

Publication upserts and resets this row. The Content Planning worker locks the marker
and each selected topic while draining at most a bounded page of credible topics,
revisioning them and marking their corpus/enrichment evidence stale. A later publication
resets the cursor under the same lock, so concurrent topic changes or publications
cannot be skipped. A document deletion first targets existing normalized topic links
before their FK cascade; source-wide changes use the workspace marker.

## Read-only derived models

### Rolling window

```text
asOf = request-frozen UTC instant
current = [asOf - 30 days, asOf)
comparison = [asOf - 60 days, asOf - 30 days)
```

### Grounding composition

```text
measured denominator = grounded + degraded + no_support
reducedOrNoSupportRate = (degraded + no_support) / measured denominator
not_evaluated = separate count where grounding_verdict is null
```

### Active remediation evidence

An observation raises priority only when its Quality evidence is effectively open or
acknowledged and it lacks passing linked Eval verification. Closed/passing evidence
remains in demand and historical grounding composition.

### Opportunity

A topic is a credible opportunity when it is mature and has active reduced/no-support
evidence from at least two distinct current-window conversations. It is a derived role,
not a table.

## State transitions

```text
observation:
  pending_context -> ready | excluded
  ready -> deleted (source cascade is physical removal in normal operation)

observation vector:
  pending_embedding -> ready -> processing -> assigned
  any claimed stage -> retryable -> processing
  retry budget exhausted -> failed

topic:
  provisional -> mature -> merged
  provisional -> retired
  mature -> merged

enrichment:
  pending -> ready
  ready -> stale -> pending -> ready
  pending -> unavailable
  pending -> outside_analysis_cap

generation:
  building -> coherent -> superseded
  building -> failed
```

## Privacy and reconciliation

1. Source message deletion cascades observation/vector/membership rows.
2. A deletion trigger/reconciliation marker identifies affected topic IDs before
   cascade or a bounded reconciliation scan detects centroid-weight drift; affected
   topics receive a revision bump, centroid rebuild, representative-ID replenishment,
   and enrichment clearing.
3. Empty provisional topics retire; empty mature topics retire from active reads and
   preserve only the minimum redirect identity needed by retention policy.
4. Source text is fetched just-in-time for detail/enrichment and is omitted immediately
   after source deletion.
5. The worker prunes superseded generation data and expired observations after the
   60-day reporting/repair horizon, while merged redirect identity remains 90 days.
