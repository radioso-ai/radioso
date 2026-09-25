import { z } from "zod";

import { AppError, notFound } from "../../shared/domain/errors.js";
import {
  exactContentItemSchema,
  validateExactContentItem,
} from "../../shared/domain/exactContent.js";
import { routineDefinitionSchema, validateExposureAcrossSnapshot, validateRoutineDefinition, type RoutineDefinition, type RoutineValidationResult } from "../routines/public.js";
import { authoredDirectiveInputSchema } from "./authoredDirectives.js";
import { describeCandidateReleaseDiff, type CandidateReleaseChange } from "./candidateReleaseReview.js";

/**
 * Bootstrap never resolves `resolveChatLocale` to a hardcoded language (it returns `null`
 * when the agent has never set `assistantDefaultLocale`), but exact content's "one
 * mandatory default-locale variant" rule (spec 1150 FR-005/FR-007) needs an actual language
 * to require. An agent that has never set a default locale falls back to English here —
 * both at draft-save time (`AgentService.updateDraftGreeting`) and at candidate/publish
 * time (`AgentRevisionRepository`) — so the two checks never disagree with each other.
 */
export const DEFAULT_AGENT_LOCALE_FALLBACK = "en";

const persistedDate = z.coerce.date();
const revisionConflict = (message: string): AppError => new AppError(409, "revision_conflict", message);
const authoredDirectiveSnapshotSchema = authoredDirectiveInputSchema.extend({
  id: z.string().uuid(), agentId: z.string().uuid(), createdAt: persistedDate, updatedAt: persistedDate,
}).strict();
// Stripping, not strict: every revision frozen before routines became plainly enabled or
// disabled carries a retired `status` key, and a pinned conversation re-parses its snapshot
// on every turn. Refusing the retired key would take out every in-flight conversation, while
// `enabled`'s default reads those snapshots back as enabled. The authoring
// `routineDefinitionSchema` stays strict.
const routineSnapshotSchema = routineDefinitionSchema
  .extend({ createdAt: persistedDate, updatedAt: persistedDate })
  .strip();
const contextVariableEnablementSnapshotSchema = z.object({
  id: z.string().uuid(), agentId: z.string().uuid(), variableId: z.string().uuid(),
  source: z.enum(["pushed", "browser", "resolver", "request"]), resolverSkillId: z.string().uuid().nullable(),
  maxAgeSeconds: z.number().int().nonnegative().nullable(), resolverTimeoutMs: z.number().int().positive().nullable(),
  surfacing: z.enum(["always", "on_reference", "operator_only"]), enabled: z.boolean(),
  createdAt: persistedDate, updatedAt: persistedDate,
}).strict();
// Mirrors AgentSkillSpine (agentSkills/domain.ts) structurally, but deliberately without
// importing agentSkills' kind/invocationMode enums: agents already exports types agentSkills
// consumes (AgentSkillRepositoryPort is type-only there), and agentSkills' repository needs
// this module's snapshot-parsing helpers to project its writes into the draft snapshot, so a
// value-level import in the other direction here would create a runtime module cycle. `kind`/
// `invocationMode` stay as validated-shape-but-open strings for the same reason a frozen
// historical snapshot should not re-validate against an enum that may evolve after the
// snapshot was written; readers that need the narrower `AgentSkillSpine` type (see
// `applyAgentRevisionSnapshot`) cast at that boundary, same as this repository's own row
// mapper already does for a raw DB column.
//
// Optional on the snapshot itself (see agentSkills below) rather than required-with-a-
// backfill-migration: repository writers (AgentSkillRepository,
// AgentRevisionRepository#createCandidate) lazily seed it from the live agent_skills table
// the first time they touch a draft/candidate whose snapshot predates this field, so no batch
// migration has to touch every existing agent_drafts/agent_revisions row.
const agentSkillSnapshotSchema = z.object({
  id: z.string().uuid(), agentId: z.string().uuid(), workspaceId: z.string().uuid(),
  skillName: z.string(), kind: z.string(), invocationMode: z.string(),
  enabled: z.boolean(), targetType: z.string().nullable().optional(), targetId: z.string().nullable().optional(),
  config: z.record(z.unknown()).optional(),
  createdAt: persistedDate, updatedAt: persistedDate,
}).strict();
// Optional on the snapshot for the same reason as `agentSkills` above: absent means "no
// exact greeting has ever been authored/carried into this draft/revision", not "exact
// words is off with empty content" — those two states happen to read back the same way
// (see `readAgentRevisionGreeting`), but only the absent case needs no migration.
const agentGreetingSnapshotSchema = z.object({
  exactWordsEnabled: z.boolean(),
  exactContent: exactContentItemSchema.nullable(),
}).strict();

/** The four fields whose behavior is released together for an agent. */
export const agentRevisionSnapshotSchema = z.object({
  customInstruction: z.string().nullable(), directives: z.array(authoredDirectiveSnapshotSchema),
  routines: z.array(routineSnapshotSchema),
  // Cutover-only continuation closure. It never participates in draft selection,
  // candidate validation, or new-routine activation; it exists solely to resume a
  // legacy conversation whose exact non-current definition was safely identified.
  retainedRoutineDefinitions: z.array(routineSnapshotSchema).optional(),
  contextVariableEnablements: z.array(contextVariableEnablementSnapshotSchema),
  // Exact greeting content (spec 1150 Slice A). See `agentGreetingSnapshotSchema` above for
  // why this is optional rather than defaulted.
  greeting: agentGreetingSnapshotSchema.optional(),
  // Agent-selectable/routine-named skill definitions (MCP tools, webhooks, etc.), frozen
  // the same way directives/routines are so a pinned conversation's turn dispatch cannot
  // read an operator's in-flight live edit. Optional/absent means "not yet tracked for
  // this draft/revision" (see the writers above), not "this agent has no skills" — a
  // reader with an absent value must fall back to the live agent_skills table rather than
  // treat it as an empty list.
  agentSkills: z.array(agentSkillSnapshotSchema).optional(),
}).strict();
export type AgentRevisionSnapshot = z.infer<typeof agentRevisionSnapshotSchema>;
export type AgentGreetingSnapshot = z.infer<typeof agentGreetingSnapshotSchema>;
export const parseAgentRevisionSnapshot = (value: unknown): AgentRevisionSnapshot => agentRevisionSnapshotSchema.parse(value);

/** Absent `greeting` (a draft/revision frozen before this field existed) reads back
 * identically to an authored-but-inactive one: Automatic mode, no content. */
export const readAgentRevisionGreeting = (snapshot: AgentRevisionSnapshot): AgentGreetingSnapshot =>
  snapshot.greeting ?? { exactWordsEnabled: false, exactContent: null };

/**
 * The authorable release surface deliberately excludes cutover-only retained
 * pins. It also gives routine arrays the same priority-first ordering used by
 * draft selection, so equivalent published and draft closures compare cleanly.
 */
const projectScopedAuthoringSnapshot = (snapshot: AgentRevisionSnapshot) => ({
  customInstruction: snapshot.customInstruction,
  directives: snapshot.directives,
  routines: [...snapshot.routines].sort((left, right) =>
    right.activation.priority - left.activation.priority ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    left.id.localeCompare(right.id)),
  contextVariableEnablements: snapshot.contextVariableEnablements,
});

export const equalScopedAuthoringSnapshots = (
  left: AgentRevisionSnapshot,
  right: AgentRevisionSnapshot,
): boolean => JSON.stringify(projectScopedAuthoringSnapshot(left)) === JSON.stringify(projectScopedAuthoringSnapshot(right));

/** Candidate/release validation happens after draft saves: incomplete graphs can
 * be authored, but cannot become a runnable immutable revision.
 *
 * `agentDefaultLocale` defaults to `DEFAULT_AGENT_LOCALE_FALLBACK` only so the small number
 * of pre-existing unit tests that call this without the option keep compiling; both real
 * callers (`AgentRevisionRepository#createCandidate`/`#publish`) always pass the agent's
 * live `assistantDefaultLocale`, because FR-005 requires re-checking against the *current*
 * default locale, not one frozen at authoring time.
 *
 * `publishedSnapshot` is the agent's currently published revision, when it has one: the
 * routines module's cross-snapshot exposure rules freeze a routine's tool name from the
 * revision that first published it, so the candidate is checked against what calling agents
 * already see. Both real callers pass it; a unit test of the other rules may leave it out. */
export const assertCandidateSnapshotIsRunnable = (
  snapshot: AgentRevisionSnapshot,
  options: { agentDefaultLocale?: string; publishedSnapshot?: AgentRevisionSnapshot | null } = {},
): void => {
  // A disabled routine cannot activate, so it cannot break a conversation: parking a
  // half-finished flow must not block the agent's release. Directive scope closure below
  // still spans every routine, because a tag naming a parked routine is still a real one.
  const diagnostics: Array<{ routineId: string | null; code: string; location: string; message: string }> = snapshot.routines.flatMap((routine) =>
    routine.enabled
      ? validateRoutineDefinition(routine).diagnostics.map((diagnostic) => ({ routineId: routine.id, ...diagnostic }))
      : []
  );
  diagnostics.push(...validateExposureAcrossSnapshot(snapshot.routines, options.publishedSnapshot?.routines ?? []));
  const routines = new Map(snapshot.routines.map((routine) => [routine.id, routine]));
  for (const directive of snapshot.directives) {
    for (const tag of directive.tags) {
      const routineMatch = /^routine:([0-9a-f-]{36})$/iu.exec(tag);
      const stepMatch = /^step:([0-9a-f-]{36}):(.+)$/iu.exec(tag);
      if (routineMatch && !routines.has(routineMatch[1])) {
        diagnostics.push({ routineId: null, code: "missing_scoped_routine", location: `directive:${directive.id}`, message: `directive scope references a routine outside this revision: ${tag}` });
      }
      if (stepMatch) {
        const routine = routines.get(stepMatch[1]);
        if (!routine || !routine.steps.some((step) => step.stableStepId === stepMatch[2])) {
          diagnostics.push({ routineId: null, code: "missing_scoped_routine_step", location: `directive:${directive.id}`, message: `directive scope references a routine step outside this revision: ${tag}` });
        }
      }
    }
  }
  const greeting = readAgentRevisionGreeting(snapshot);
  if (greeting.exactWordsEnabled) {
    if (!greeting.exactContent) {
      diagnostics.push({ routineId: null, code: "missing_exact_greeting_content", location: "greeting", message: "Exact words is enabled for the greeting but no content is authored" });
    } else {
      const validation = validateExactContentItem(greeting.exactContent, {
        agentDefaultLocale: options.agentDefaultLocale ?? DEFAULT_AGENT_LOCALE_FALLBACK,
        // Bootstrap supplies no context variables and the greeting has no routine slots
        // (spec 1150 F4); every `{{…}}` in greeting content is therefore unknown.
        availableReferenceKeys: new Set(),
      });
      if (!validation.ok) {
        diagnostics.push(...validation.issues.map((issue) => ({ routineId: null, code: issue.code, location: `greeting.${issue.path}`, message: issue.message })));
      }
    }
  }
  if (diagnostics.length > 0) {
    throw new AppError(422, "revision_invalid", "The draft contains content that cannot be released.", { diagnostics });
  }
};

/**
 * The skill/capability/webhook-aware half of "can this actually serve?" — what
 * `RoutineDefinitionService.validateForServing` already knows how to check, but which
 * `assertCandidateSnapshotIsRunnable` above cannot run itself: that check is pure and
 * synchronous so the repository can call it inside its own transaction, with no workspace-scoped
 * catalog, capability policy, or webhook-destination reader in scope there. This narrow port lets
 * the revision service run the same servability check the old per-routine `publish`/`restore`
 * ran, from a layer that does have those dependencies, before a routine goes live.
 */
export interface RoutineServingValidator {
  validateForServing(workspaceId: string, routine: RoutineDefinition): Promise<RoutineValidationResult>;
  /**
   * Optional batched capability: every routine served to this method belongs to one agent, so the
   * workspace-scoped skill/capability/context-variable state a servability check needs is the same
   * for all of them and only has to be resolved once. Absent on a narrower test double (or a caller
   * that never got the batched service wired up) — `assertCandidateSnapshotIsServable` falls back to
   * one `validateForServing` call per routine when this is missing.
   */
  validateManyForServing?(
    workspaceId: string,
    routines: readonly RoutineDefinition[],
  ): Promise<Map<string, RoutineValidationResult>>;
}

/**
 * A disabled routine cannot activate, so a stale skill/capability/webhook reference on one
 * cannot break a conversation — only an enabled routine's servability blocks a release, mirroring
 * the structural check's own enabled-only scope above.
 */
const assertCandidateSnapshotIsServable = async (
  workspaceId: string,
  snapshot: AgentRevisionSnapshot,
  validator: RoutineServingValidator,
): Promise<void> => {
  const enabledRoutines = snapshot.routines.filter((routine) => routine.enabled);
  const results = validator.validateManyForServing
    ? await validator.validateManyForServing(workspaceId, enabledRoutines)
    : new Map(await Promise.all(
        enabledRoutines.map(async (routine) => [routine.id, await validator.validateForServing(workspaceId, routine)] as const),
      ));
  const diagnostics = enabledRoutines.flatMap((routine) => {
    const result = results.get(routine.id);
    return result && !result.ok ? result.diagnostics.map((diagnostic) => ({ routineId: routine.id, ...diagnostic })) : [];
  });
  if (diagnostics.length > 0) {
    throw new AppError(422, "revision_invalid", "The draft contains a routine that cannot be released.", { diagnostics });
  }
};

export interface AgentDraft { generation: number; basePublishedRevisionId: string | null; snapshot: AgentRevisionSnapshot; updatedAt: Date; }
export interface AgentRevision {
  id: string;
  snapshot: AgentRevisionSnapshot;
  sourceDraftGeneration: number;
  sourceBasePublishedRevisionId: string | null;
  createdAt: Date;
  publishedAt: Date | null;
  /** Allocated only by a successful publication; draft generations are not releases. */
  publishedVersion: number | null;
}
export interface AgentRevisionState {
  agentId: string;
  status: "unpublished" | "draft_clean" | "draft_dirty" | "published_changed_since_draft";
  draft: Pick<AgentDraft, "generation" | "basePublishedRevisionId" | "updatedAt">;
  publishedRevision: AgentRevision | null;
  canPublish: boolean;
}
export interface PublicationResult { publicationId: string; publishedAt: Date; revisionId: string; idempotentReplay: boolean; }
interface CandidateReleaseReview { candidateRevisionId: string; basePublishedRevisionId: string | null; validation: { status: "valid" }; changes: ReadonlyArray<CandidateReleaseChange>; truncated: boolean; nextOffset: number | null; }

export interface AgentRevisionRepositoryPort {
  initializeDraft(workspaceId: string, agentId: string, customInstruction: string): Promise<void>;
  mutateDraft(workspaceId: string, agentId: string, mutate: (snapshot: AgentRevisionSnapshot) => AgentRevisionSnapshot): Promise<AgentDraft | null>;
  readDraft(workspaceId: string, agentId: string): Promise<AgentDraft | null>;
  readState(workspaceId: string, agentId: string): Promise<AgentRevisionState | null>;
  findRevision(workspaceId: string, agentId: string, revisionId: string): Promise<AgentRevision | null>;
  findRevisionByWorkspace(input: { workspaceId: string; revisionId: string }): Promise<{ agentId: string; revision: AgentRevision } | null>;
  listRevisions(workspaceId: string, agentId: string): Promise<AgentRevision[]>;
  createCandidate(workspaceId: string, agentId: string, candidate: { id: string; expectedDraftGeneration: number }): Promise<AgentRevision | "conflict">;
  publish(input: { workspaceId: string; agentId: string; actorAccountId: string | null; revisionId: string; expectedDraftGeneration: number; expectedPublishedRevisionId: string | null; idempotencyKey: string }): Promise<"conflict" | "idempotency_mismatch" | PublicationResult>;
}

export class AgentRevisionService {
  constructor(
    private readonly repository: AgentRevisionRepositoryPort,
    private readonly createId: () => string,
    /**
     * Optional: absent in a context with no workspace-scoped skill/capability/webhook services
     * (e.g. a unit test exercising draft/publish plumbing alone), in which case only the
     * repository's own structural + directive-scope check still runs.
     */
    private readonly routineServingValidator?: RoutineServingValidator,
  ) {}
  initializeDraft(workspaceId: string, agentId: string, customInstruction: string): Promise<void> {
    return this.repository.initializeDraft(workspaceId, agentId, customInstruction);
  }
  async mutateDraft(workspaceId: string, agentId: string, mutate: (snapshot: AgentRevisionSnapshot) => AgentRevisionSnapshot): Promise<AgentDraft> {
    const draft = await this.repository.mutateDraft(workspaceId, agentId, mutate);
    if (!draft) throw notFound("Agent draft not found");
    return draft;
  }
  async state(workspaceId: string, agentId: string): Promise<AgentRevisionState> {
    const state = await this.repository.readState(workspaceId, agentId);
    if (!state) throw notFound("Agent draft not found");
    return state;
  }
  async createCandidate(workspaceId: string, agentId: string, expectedDraftGeneration: number): Promise<AgentRevision> {
    // Checked against the current draft before the repository freezes it: a stale reference
    // (a deleted skill, a since-denied capability, a removed webhook destination) must not
    // become a candidate a reviewer is invited to publish. A benign race with a concurrent
    // draft edit is caught below anyway, by the repository's own generation guard.
    if (this.routineServingValidator) {
      const draft = await this.repository.readDraft(workspaceId, agentId);
      if (draft) await assertCandidateSnapshotIsServable(workspaceId, draft.snapshot, this.routineServingValidator);
    }
    const candidate = await this.repository.createCandidate(workspaceId, agentId, { id: this.createId(), expectedDraftGeneration });
    if (candidate === "conflict") throw revisionConflict("Agent draft changed before the candidate was created.");
    return candidate;
  }
  /**
   * The revision a test runs when the operator names none: a fresh candidate of the saved draft,
   * or the published revision when the draft holds exactly what is published. An agent that was
   * never published has only its candidate to test. The generation lets the caller fence the test
   * start against a draft edit made after the choice.
   */
  async resolveDefaultTestRevision(workspaceId: string, agentId: string): Promise<{ revisionId: string; expectedDraftGeneration: number }> {
    const state = await this.state(workspaceId, agentId);
    const expectedDraftGeneration = state.draft.generation;
    if (state.status === "draft_clean" && state.publishedRevision) return { revisionId: state.publishedRevision.id, expectedDraftGeneration };
    const candidate = await this.createCandidate(workspaceId, agentId, expectedDraftGeneration);
    return { revisionId: candidate.id, expectedDraftGeneration };
  }
  async list(workspaceId: string, agentId: string): Promise<AgentRevision[]> { await this.state(workspaceId, agentId); return this.repository.listRevisions(workspaceId, agentId); }
  async detail(workspaceId: string, agentId: string, revisionId: string): Promise<AgentRevision> {
    const revision = await this.repository.findRevision(workspaceId, agentId, revisionId);
    if (!revision) throw notFound("Agent revision not found");
    return revision;
  }
  async describeCandidateRelease(workspaceId: string, agentId: string, revisionId: string, page?: { offset?: number; limit?: number }): Promise<CandidateReleaseReview> {
    const candidate = await this.detail(workspaceId, agentId, revisionId);
    assertCandidateSnapshotIsRunnable(candidate.snapshot);
    const base = candidate.sourceBasePublishedRevisionId ? await this.detail(workspaceId, agentId, candidate.sourceBasePublishedRevisionId) : null;
    return { candidateRevisionId: candidate.id, basePublishedRevisionId: candidate.sourceBasePublishedRevisionId, validation: { status: "valid" }, ...describeCandidateReleaseDiff(base?.snapshot ?? null, candidate.snapshot, page) };
  }
  async readCandidateReleaseChange(workspaceId: string, agentId: string, revisionId: string, input: { field: "customInstruction" | "directives" | "routines" | "contextVariableEnablements" | "agentSkills"; id: string; side: "before" | "after"; offset: number; limit: number }): Promise<{ text: string | null; nextOffset: number | null; totalLength: number }> {
    if (!Number.isInteger(input.offset) || input.offset < 0 || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 2000) throw new AppError(400, "invalid_release_review_chunk", "Invalid release review chunk range.");
    const candidate = await this.detail(workspaceId, agentId, revisionId);
    const base = candidate.sourceBasePublishedRevisionId ? await this.detail(workspaceId, agentId, candidate.sourceBasePublishedRevisionId) : null;
    if (input.field === "customInstruction" && input.id !== "agent") throw new AppError(404, "release_review_change_not_found", "Release review change was not found.");
    const beforeCollection = input.field === "customInstruction" ? [] : (base?.snapshot[input.field] as ReadonlyArray<{ id: string }> | undefined) ?? [];
    const afterCollection = input.field === "customInstruction" ? [] : (candidate.snapshot[input.field] as ReadonlyArray<{ id: string }> | undefined) ?? [];
    if (input.field !== "customInstruction" && !beforeCollection.some((entry) => entry.id === input.id) && !afterCollection.some((entry) => entry.id === input.id)) throw new AppError(404, "release_review_change_not_found", "Release review change was not found.");
    const snapshot = input.side === "before" ? base?.snapshot : candidate.snapshot;
    const value = input.field === "customInstruction" ? snapshot?.customInstruction ?? null : (input.side === "before" ? beforeCollection : afterCollection).find((entry) => entry.id === input.id) ?? null;
    if (value === null) return { text: null, nextOffset: null, totalLength: 0 };
    const safeValue = input.field === "agentSkills" && typeof value === "object"
      ? (() => { const { config: _config, ...metadata } = value as Record<string, unknown>; return metadata; })()
      : value;
    const full = typeof safeValue === "string" ? safeValue : JSON.stringify(safeValue);
    return { text: full.slice(input.offset, input.offset + input.limit), nextOffset: input.offset + input.limit < full.length ? input.offset + input.limit : null, totalLength: full.length };
  }
  async publish(workspaceId: string, agentId: string, actorAccountId: string | null, input: { revisionId: string; expectedDraftGeneration: number; expectedPublishedRevisionId: string | null; idempotencyKey: string }): Promise<PublicationResult> {
    // A candidate is checked for servability when it is created, but the workspace can still
    // move under it before it is published (a skill deleted, a capability revoked, a webhook
    // destination removed) — old `restore` re-checked at exactly this moment, so publish does
    // too. Skipped for a revision that is already the published one: that publish call can only
    // be an idempotent replay, which must keep returning its original result regardless of what
    // has changed in the workspace since.
    if (this.routineServingValidator) {
      const revision = await this.repository.findRevision(workspaceId, agentId, input.revisionId);
      // An older revision can be retried after another revision becomes current. It is still
      // already published, and the repository will return its saved idempotency result (or an
      // idempotency conflict), so current workspace dependencies must not revalidate it first.
      if (revision && revision.publishedAt === null) {
        await assertCandidateSnapshotIsServable(workspaceId, revision.snapshot, this.routineServingValidator);
      }
    }
    const result = await this.repository.publish({ workspaceId, agentId, actorAccountId, ...input });
    if (result === "idempotency_mismatch") throw revisionConflict("This idempotency key was already used for another publication command.");
    if (result === "conflict") throw revisionConflict("The agent draft or published revision changed before publication.");
    return result;
  }
}
