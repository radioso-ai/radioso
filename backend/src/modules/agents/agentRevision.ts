import { z } from "zod";

import { AppError, notFound } from "../../shared/domain/errors.js";
import { routineDefinitionSchema, validateRoutineDefinition } from "../routines/public.js";
import { authoredDirectiveInputSchema } from "./authoredDirectives.js";

const persistedDate = z.coerce.date();
const revisionConflict = (message: string): AppError => new AppError(409, "revision_conflict", message);
const authoredDirectiveSnapshotSchema = authoredDirectiveInputSchema.extend({
  id: z.string().uuid(), agentId: z.string().uuid(), createdAt: persistedDate, updatedAt: persistedDate,
}).strict();
const routineSnapshotSchema = routineDefinitionSchema.extend({ createdAt: persistedDate, updatedAt: persistedDate });
const contextVariableEnablementSnapshotSchema = z.object({
  id: z.string().uuid(), agentId: z.string().uuid(), variableId: z.string().uuid(),
  source: z.enum(["pushed", "browser", "resolver"]), resolverSkillId: z.string().uuid().nullable(),
  maxAgeSeconds: z.number().int().nonnegative().nullable(), resolverTimeoutMs: z.number().int().positive().nullable(),
  surfacing: z.enum(["always", "on_reference", "operator_only"]), enabled: z.boolean(),
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
  const diagnostics: Array<{ routineId: string | null; code: string; location: string; message: string }> = snapshot.routines.flatMap((routine) =>
    validateRoutineDefinition(routine).diagnostics.map((diagnostic) => ({ routineId: routine.id, ...diagnostic }))
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
  constructor(private readonly repository: AgentRevisionRepositoryPort, private readonly createId: () => string) {}
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
    const result = await this.repository.publish({ workspaceId, agentId, actorAccountId, ...input });
    if (result === "idempotency_mismatch") throw revisionConflict("This idempotency key was already used for another publication command.");
    if (result === "conflict") throw revisionConflict("The agent draft or published revision changed before publication.");
    return result;
  }
}
