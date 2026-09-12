import { z } from "zod";

import { AppError, notFound } from "../../shared/domain/errors.js";
import { routineDefinitionSchema, validateRoutineDefinition, type RoutineDefinition, type RoutineValidationResult } from "../routines/public.js";
import { authoredDirectiveInputSchema } from "./authoredDirectives.js";

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
  source: z.enum(["pushed", "browser", "resolver"]), resolverSkillId: z.string().uuid().nullable(),
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

/** The four fields whose behavior is released together for an agent. */
export const agentRevisionSnapshotSchema = z.object({
  customInstruction: z.string().nullable(), directives: z.array(authoredDirectiveSnapshotSchema),
  routines: z.array(routineSnapshotSchema),
  // Cutover-only continuation closure. It never participates in draft selection,
  // candidate validation, or new-routine activation; it exists solely to resume a
  // legacy conversation whose exact non-current definition was safely identified.
  retainedRoutineDefinitions: z.array(routineSnapshotSchema).optional(),
  contextVariableEnablements: z.array(contextVariableEnablementSnapshotSchema),
  // Agent-selectable/routine-named skill definitions (MCP tools, webhooks, etc.), frozen
  // the same way directives/routines are so a pinned conversation's turn dispatch cannot
  // read an operator's in-flight live edit. Optional/absent means "not yet tracked for
  // this draft/revision" (see the writers above), not "this agent has no skills" — a
  // reader with an absent value must fall back to the live agent_skills table rather than
  // treat it as an empty list.
  agentSkills: z.array(agentSkillSnapshotSchema).optional(),
}).strict();
export type AgentRevisionSnapshot = z.infer<typeof agentRevisionSnapshotSchema>;
export const parseAgentRevisionSnapshot = (value: unknown): AgentRevisionSnapshot => agentRevisionSnapshotSchema.parse(value);

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
 * be authored, but cannot become a runnable immutable revision. */
export const assertCandidateSnapshotIsRunnable = (snapshot: AgentRevisionSnapshot): void => {
  // A disabled routine cannot activate, so it cannot break a conversation: parking a
  // half-finished flow must not block the agent's release. Directive scope closure below
  // still spans every routine, because a tag naming a parked routine is still a real one.
  const diagnostics: Array<{ routineId: string | null; code: string; location: string; message: string }> = snapshot.routines.flatMap((routine) =>
    routine.enabled
      ? validateRoutineDefinition(routine).diagnostics.map((diagnostic) => ({ routineId: routine.id, ...diagnostic }))
      : []
  );
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
  if (diagnostics.length > 0) {
    throw new AppError(422, "revision_invalid", "The draft contains a routine graph that cannot be released.", { diagnostics });
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
  async list(workspaceId: string, agentId: string): Promise<AgentRevision[]> { await this.state(workspaceId, agentId); return this.repository.listRevisions(workspaceId, agentId); }
  async detail(workspaceId: string, agentId: string, revisionId: string): Promise<AgentRevision> {
    const revision = await this.repository.findRevision(workspaceId, agentId, revisionId);
    if (!revision) throw notFound("Agent revision not found");
    return revision;
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
