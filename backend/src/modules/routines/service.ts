import { randomUUID } from "node:crypto";

import { badRequest, conflict, notFound } from "../../shared/domain/errors.js";
import { DefaultAllowCapabilityPolicy, type CapabilityPolicy } from "../../shared/domain/capabilityPolicy.js";
import type { ActionCapabilityMap } from "../../shared/domain/actionCapabilities.js";
import type { AuditEventInput, AuditPort } from "../audit/contracts/index.js";
import { resolveAvailableContextVariables, type AgentContextVariableEnablement } from "../context-variables/public.js";
import type { SkillAuthoringCatalog } from "../skills/public.js";
import { draftInputFromRoutine } from "./authoringEdit.js";
import {
  routineDefinitionDraftInputSchema,
  type RoutineDefinition,
  type RoutineDefinitionDraftInput,
  type RoutineDefinitionDraftAuthoringInput,
} from "./domain.js";
import type { RoutineTriggerEmbeddingService } from "./routineTriggerEmbeddingService.js";
import {
  validateRoutineDefinition,
  type RoutineValidationContext,
  type RoutineValidationDiagnostic,
  type RoutineValidationResult,
} from "./validator.js";

export interface RoutineDefinitionRepositoryPort {
  listByAgent(agentId: string): Promise<RoutineDefinition[]>;
  findById(agentId: string, id: string): Promise<RoutineDefinition | null>;
  createDraft(agentId: string, input: RoutineDefinitionDraftInput): Promise<RoutineDefinition>;
  updateDraft(agentId: string, id: string, input: RoutineDefinitionDraftInput, options?: RoutineDefinitionWriteGuard): Promise<RoutineDefinition>;
  deleteDraft(agentId: string, id: string, options?: RoutineDefinitionWriteGuard): Promise<RoutineDefinitionDeleteDraftResult>;
  createDraftWithAgentDraft(workspaceId: string, agentId: string, input: RoutineDefinitionDraftInput): Promise<RoutineDefinition>;
  updateDraftWithAgentDraft(workspaceId: string, agentId: string, id: string, input: RoutineDefinitionDraftInput, options?: RoutineDefinitionWriteGuard): Promise<RoutineDefinition>;
  setEnabledWithAgentDraft(workspaceId: string, agentId: string, id: string, enabled: boolean): Promise<RoutineDefinition | null>;
  deleteDraftWithAgentDraft(workspaceId: string, agentId: string, id: string, options?: RoutineDefinitionWriteGuard): Promise<RoutineDefinitionDeleteDraftResult>;
  listRoutineNamesReferencingDestination?(workspaceId: string, destinationId: string): Promise<string[]>;
  findNameVersionOneOccupant?(agentId: string, name: string): Promise<{ id: string; updatedAt: Date } | null>;
}

/**
 * Optimistic guard for a write authored elsewhere. The caller read the routine, decided what to
 * change, and states the version it decided against; the repository refuses the write if anything
 * moved in between, so a version check made in application code cannot be raced by a concurrent
 * edit landing between the check and the write.
 */
export interface RoutineDefinitionWriteGuard {
  expectedUpdatedAt?: Date;
}

interface RoutineDefinitionSaveResult {
  routine: RoutineDefinition;
  validation: RoutineValidationResult;
}

export type RoutineDefinitionDeleteDraftResult =
  | { outcome: "deleted" }
  | { outcome: "not_found" }
  | { outcome: "conflict" };

interface RoutineDefinitionServiceOptions {
  agentRepository: {
    findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<unknown>;
  };
  repository: RoutineDefinitionRepositoryPort;
  actionCapabilities?: ActionCapabilityMap;
  capabilityPolicy?: CapabilityPolicy;
  webhookDestinations?: {
    existsByIdAndWorkspace(workspaceId: string, destinationId: string): Promise<boolean>;
  };
  skillAuthoringCatalog?: SkillAuthoringCatalog;
  contextVariableReader?: {
    listByAgent(workspaceId: string, agentId: string): Promise<AgentContextVariableEnablement[]>;
  };
  /**
   * Names of routine-dispatchable skills that the authoring catalog does not
   * enumerate but the runtime resolver still routes (customer-email, webhook).
   * Folded into the serving allow-list so existing routines that use them are
   * not rejected as `unknown_skill`. Must mirror the runtime resolver's name
   * derivation (enabled skills only).
   */
  additionalRoutineSkillNames?: (input: {
    workspaceId: string;
    agentId: string;
  }) => Promise<readonly string[]>;
  auditService?: Pick<AuditPort, "record">;
  triggerEmbeddingService?: Pick<RoutineTriggerEmbeddingService, "persistPublished">;
  /** Support/debug correlation for the best-effort side effects `savedRoutine` fires off. */
  logger?: { warn(bindings: Record<string, unknown>, message: string): void };
}

/** Overlays only the keys `incoming` actually defines onto `base`, leaving the rest untouched. */
const mergeDefinedFields = <T extends Record<string, unknown>>(base: T, incoming: Partial<T>): T => {
  const definedIncoming = Object.fromEntries(
    Object.entries(incoming).filter(([, fieldValue]) => fieldValue !== undefined),
  );
  return { ...base, ...definedIncoming };
};

/**
 * A plain update payload (the form/document editor's full-body PATCH) is a full draft shape,
 * so a field it never mentions reads the same as a field explicitly cleared — and a field with
 * a zod default (`enabled`) would then default forward instead of carrying the stored value.
 * Overlaying only the keys the caller's payload actually defines onto the stored routine's own
 * draft shape fixes that at the source, the same base+overlay presence-check
 * `applyRoutineFieldPatch` already uses for a field-level edit, applied here at the whole-payload
 * granularity the plain update endpoint receives. Issue: enabled-reset bug (routine lifecycle
 * collapse regression #1).
 *
 * The same reset can happen one level deeper: a caller-sent `activation` or `completionExport`
 * object can itself omit one of its own optional-with-default subfields
 * (`activation.reentryMode`; every `completionExport` field), which — same root cause —
 * `RoutineDefinitionDraftUpdateInputSchema` keeps genuinely `undefined` rather than defaulted.
 * Merge those two nested objects field-by-field too, not just replace them wholesale. `activation`
 * is always present on a routine (required, never itself omitted); `completionExport` can be
 * entirely absent from `input`, in which case the whole-payload merge above already carries the
 * stored value forward untouched. Issue: enabled-reset bug, one level deeper (round 2, item 7).
 */
const mergeDraftInputWithExisting = (
  existing: RoutineDefinition,
  input: RoutineDefinitionDraftAuthoringInput,
): RoutineDefinitionDraftAuthoringInput => {
  const existingDraft = draftInputFromRoutine(existing);
  const merged = mergeDefinedFields(
    existingDraft as unknown as Record<string, unknown>,
    input as unknown as Record<string, unknown>,
  ) as RoutineDefinitionDraftAuthoringInput;
  return {
    ...merged,
    activation: mergeDefinedFields(existingDraft.activation, input.activation),
    ...(input.completionExport === undefined ? {} : {
      completionExport: mergeDefinedFields(
        (existingDraft.completionExport ?? {}),
        input.completionExport,
      ),
    }),
  };
};

const draftDefinitionFromInput = (agentId: string, input: RoutineDefinitionDraftInput): RoutineDefinition => ({
  id: randomUUID(),
  agentId,
  lineageId: randomUUID(),
  version: 1,
  ...input,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const isUuid = (value: string): boolean => uuidPattern.test(value);

const invalidWebhookDestinationDiagnostic = (destinationRef: string): RoutineValidationDiagnostic => ({
  code: "invalid_webhook_destination_ref",
  location: "completionExport.destinationRef",
  message: `invalid webhook destination reference: completion export references "${destinationRef}", but destinationRef must be a webhook destination UUID.`,
});

const unknownWebhookDestinationDiagnostic = (destinationRef: string): RoutineValidationDiagnostic => ({
  code: "unknown_webhook_destination",
  location: "completionExport.destinationRef",
  message: `unknown webhook destination: completion export references "${destinationRef}", but that destination does not exist in this workspace.`,
});

const isRoutineCompletionExportDestinationConstraintError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: unknown; constraint?: unknown; message?: unknown };
  return record.code === "23503" &&
    (
      record.constraint === "routine_completion_export_destination_ref_published_fk" ||
      (typeof record.message === "string" && record.message.includes("completion export references unknown webhook destination"))
    );
};

const isRoutineDefinitionNameVersionConstraintError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: unknown; constraint?: unknown; message?: unknown };
  return record.code === "23505" &&
    (
      record.constraint === "routine_definition_agent_id_name_version_key" ||
      (typeof record.message === "string" && record.message.includes("routine_definition_agent_id_name_version_key"))
    );
};

export class RoutineDefinitionService {
  private readonly capabilityPolicy: CapabilityPolicy;

  constructor(private readonly options: RoutineDefinitionServiceOptions) {
    this.capabilityPolicy = options.capabilityPolicy ?? new DefaultAllowCapabilityPolicy();
  }

  async list(workspaceId: string, agentId: string): Promise<RoutineDefinition[]> {
    await this.requireAgent(workspaceId, agentId);
    return this.options.repository.listByAgent(agentId);
  }

  async get(workspaceId: string, agentId: string, id: string): Promise<RoutineDefinition> {
    await this.requireAgent(workspaceId, agentId);
    return this.requireRoutine(agentId, id);
  }

  async createDraft(
    workspaceId: string,
    agentId: string,
    input: RoutineDefinitionDraftAuthoringInput,
  ): Promise<RoutineDefinitionSaveResult> {
    await this.requireAgent(workspaceId, agentId);
    const draft = this.validateInput(input);
    // A retired, non-canonical row from a pre-cutover branched lineage can still occupy
    // (agent_id, name, version 1) — the identity a fresh create always takes — while being
    // invisible to list()'s canonical-row-only view, so a name that looks free to every caller of
    // this method is not. Checking that before attempting the write, rather than only catching the
    // database's own unique-violation after the fact, gives every caller (the plain dashboard/API
    // path and the copilot's) the same precise pre-write guidance instead of the copilot's own
    // findCreateConflict precheck being the only place this got caught early. The post-write catch
    // below stays as a correctness safety net for the race window between this check and the write.
    if (await this.options.repository.findNameVersionOneOccupant?.(agentId, draft.name)) {
      throw conflict("A routine definition with this name and version already exists for this agent");
    }
    let saved: RoutineDefinition;
    try {
      saved = await this.options.repository.createDraftWithAgentDraft(workspaceId, agentId, draft);
    } catch (error) {
      if (isRoutineDefinitionNameVersionConstraintError(error)) {
        throw conflict("A routine definition with this name and version already exists for this agent");
      }
      throw this.completionExportDestinationError(error, draft) ?? error;
    }
    return this.savedRoutine(workspaceId, agentId, "routine_definition.create", saved);
  }

  /**
   * The row, if any, that would make a fresh `createDraft(workspaceId, agentId, { name, ... })`
   * fail with a name conflict — checked without attempting the write, for a caller (the copilot's
   * create-proposal version token) that needs to know a create is blocked before Apply runs it.
   * Deliberately not backed by `list()`: that returns one canonical row per lineage, which can
   * miss a real conflict from a retired, non-canonical row a pre-cutover lineage still carries at
   * `(name, version 1)` under a name its canonical row has since been renamed away from.
   */
  async findCreateConflict(
    workspaceId: string,
    agentId: string,
    name: string,
  ): Promise<{ id: string; updatedAt: Date } | null> {
    await this.requireAgent(workspaceId, agentId);
    return (await this.options.repository.findNameVersionOneOccupant?.(agentId, name)) ?? null;
  }

  async updateDraft(
    workspaceId: string,
    agentId: string,
    id: string,
    input: RoutineDefinitionDraftAuthoringInput,
    options: RoutineDefinitionWriteGuard = {},
  ): Promise<RoutineDefinitionSaveResult> {
    await this.requireAgent(workspaceId, agentId);
    // A caller's payload may omit a field the stored routine already carries a real value for
    // (see mergeDraftInputWithExisting); look the routine up first so an omission carries
    // forward instead of falling back to a schema default. A missing id is not a hard failure
    // here — the repository's own conflict guard below still reports it precisely.
    const existing = await this.options.repository.findById(agentId, id);
    const draft = this.validateInput(existing ? mergeDraftInputWithExisting(existing, input) : input);
    let saved: RoutineDefinition;
    try {
      saved = await this.options.repository.updateDraftWithAgentDraft(workspaceId, agentId, id, draft, options);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("routine_definition_update_conflict:")) {
        throw conflict("Routine changed while it was being edited — reload it and try again");
      }
      // Every canonical routine is now permanently pinned at version 1 (the routine lifecycle
      // collapse), so renaming one routine to collide with another's name is the common case a
      // rename can hit, not the rare cross-lineage edge case it was under the old branching-
      // version model. createDraft already reports this collision as a friendly 409; do the same
      // here instead of letting the raw unique-violation escape as a 500.
      if (isRoutineDefinitionNameVersionConstraintError(error)) {
        throw conflict("A routine definition with this name and version already exists for this agent");
      }
      throw this.completionExportDestinationError(error, draft) ?? error;
    }
    return this.savedRoutine(workspaceId, agentId, "routine_definition.update", saved);
  }

  /** Takes a routine in or out of service, leaving its authored graph untouched. */
  async setEnabled(
    workspaceId: string,
    agentId: string,
    id: string,
    enabled: boolean,
  ): Promise<RoutineDefinitionSaveResult> {
    await this.requireAgent(workspaceId, agentId);
    const saved = await this.options.repository.setEnabledWithAgentDraft(workspaceId, agentId, id, enabled);
    if (!saved) {
      throw notFound("Routine definition not found");
    }
    return this.savedRoutine(workspaceId, agentId, "routine_definition.update", saved);
  }

  async validate(
    workspaceId: string,
    agentId: string,
    target: { id: string } | { input: RoutineDefinitionDraftAuthoringInput },
  ): Promise<RoutineValidationResult> {
    await this.requireAgent(workspaceId, agentId);
    // Validation answers "would this serve?", so it runs every gate the agent's own release runs.
    // Leaving out an unregistered action type or a capability the workspace denies would report a
    // routine as valid that could never go live.
    const routine = "id" in target
      ? await this.requireRoutine(agentId, target.id)
      : draftDefinitionFromInput(agentId, this.validateInput(target.input));
    return this.validateForServing(workspaceId, routine);
  }

  async deleteDraft(workspaceId: string, agentId: string, id: string, options: RoutineDefinitionWriteGuard = {}): Promise<void> {
    await this.requireAgent(workspaceId, agentId);
    const result = await this.options.repository.deleteDraftWithAgentDraft(workspaceId, agentId, id, options);
    if (result.outcome === "conflict") {
      throw conflict("Routine changed while its draft was being deleted — reload it and try again");
    }
    if (result.outcome === "not_found") {
      throw notFound("Draft routine definition not found");
    }
  }

  /**
   * The shared tail of a routine write: keep the activation prefilter's trigger embedding in step
   * with the wording that was just saved, record the authoring event, and report the routine with
   * its structural diagnostics. Losing the embedding refresh here would silently stop an edited
   * routine from matching — but the routine's own content already committed by the time this
   * runs, so neither side effect is allowed to turn that already-successful save into a reported
   * error: `persistPublished` is best-effort by its own contract (it never rejects), and
   * `recordAuthoringAudit` catches and logs rather than propagating, for the same reason and for
   * consistency with how `turnProvider.ts` treats this same embedding call as fire-and-forget on
   * the live turn path.
   */
  private async savedRoutine(
    workspaceId: string,
    agentId: string,
    eventType: AuditEventInput["eventType"],
    routine: RoutineDefinition,
  ): Promise<RoutineDefinitionSaveResult> {
    // Neither depends on the other's result, so they run concurrently rather than serially.
    await Promise.all([
      this.options.triggerEmbeddingService?.persistPublished({ workspaceId, agentId, routine }),
      this.recordAuthoringAudit(eventType, workspaceId, agentId, routine),
    ]);
    return { routine, validation: validateRoutineDefinition(routine) };
  }

  /**
   * A routine serves as soon as the agent's draft is released, so the database refuses a completion
   * export whose webhook destination does not exist. Report that as an author-facing diagnostic
   * rather than letting a constraint violation surface as a server error.
   */
  private completionExportDestinationError(error: unknown, draft: RoutineDefinitionDraftInput): Error | null {
    if (!isRoutineCompletionExportDestinationConstraintError(error) || !draft.completionExport?.enabled) {
      return null;
    }
    const diagnostic = unknownWebhookDestinationDiagnostic(draft.completionExport.destinationRef.trim());
    return badRequest(diagnostic.message, { ok: false, diagnostics: [diagnostic] });
  }

  private validateInput(input: RoutineDefinitionDraftAuthoringInput): RoutineDefinitionDraftInput {
    const parsed = routineDefinitionDraftInputSchema.safeParse(input);
    if (!parsed.success) {
      throw badRequest("Invalid routine definition input", parsed.error.flatten());
    }
    return parsed.data;
  }

  private async requireAgent(workspaceId: string, agentId: string): Promise<void> {
    const agent = await this.options.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) {
      throw notFound("Agent not found");
    }
  }

  private async requireRoutine(agentId: string, id: string): Promise<RoutineDefinition> {
    const routine = await this.options.repository.findById(agentId, id);
    if (!routine) {
      throw notFound("Routine definition not found");
    }
    return routine;
  }

  /**
   * The workspace+agent-scoped half of serving validation: the skill catalog, the
   * runtime-resolvable skill names the catalog does not enumerate, and the agent's context
   * variables. Identical for every routine belonging to the same agent, so a caller validating
   * several of an agent's routines in one pass (`validateManyForServing`) resolves this once and
   * reuses it, instead of each routine independently repeating the same three reads.
   */
  private async resolveServingContext(workspaceId: string, agentId: string): Promise<RoutineValidationContext> {
    if (!this.options.skillAuthoringCatalog) {
      return {};
    }
    const [descriptors, additionalNames, contextVariables] = await Promise.all([
      this.options.skillAuthoringCatalog.listForAgent({ workspaceId, agentId }),
      this.options.additionalRoutineSkillNames?.({ workspaceId, agentId }) ?? Promise.resolve([]),
      this.options.contextVariableReader?.listByAgent(workspaceId, agentId) ?? Promise.resolve([]),
    ]);
    return {
      // The catalog covers built-in + external skills (which also carry typed
      // descriptors); webhook/customer-email skills are runtime-resolvable but
      // not catalogued, so add their names to the allow-list to avoid false
      // `unknown_skill` rejections.
      availableSkillNames: new Set([
        ...descriptors.map((descriptor) => descriptor.skillName),
        ...additionalNames,
      ]),
      skillDescriptors: new Map(descriptors.map((descriptor) => [descriptor.skillName, descriptor])),
      availableContextVariables: resolveAvailableContextVariables(contextVariables),
    };
  }

  private async validateWithAvailableSkills(
    workspaceId: string,
    routine: RoutineDefinition,
  ): Promise<RoutineValidationResult> {
    const context = await this.resolveServingContext(workspaceId, routine.agentId);
    return validateRoutineDefinition(routine, context);
  }

  /**
   * Every gate a routine must clear to actually run: structural validity, skill/context-variable
   * availability, action-capability authorization, and a servable completion-export destination.
   * Public because the agent-revision release gate (`assertCandidateSnapshotIsServable` in
   * `modules/agents/agentRevision.ts`) is the one place left that decides whether a routine may
   * go live, and it validates the routine objects frozen in a candidate snapshot directly rather
   * than through a `{ id }` lookup.
   */
  async validateForServing(
    workspaceId: string,
    routine: RoutineDefinition,
  ): Promise<RoutineValidationResult> {
    const validation = await this.validateWithAvailableSkills(workspaceId, routine);
    const actionValidation = await this.validateActionAuthorization(workspaceId, routine, validation);
    return this.validateServingReferences(workspaceId, routine, actionValidation);
  }

  /**
   * The batched form of `validateForServing` for routines that all belong to one agent — every
   * `createCandidate`/`publish`/agent-bundle-import call validates a whole snapshot's worth of
   * enabled routines at once, and they always share one agent. Resolving the workspace-scoped
   * skill/context-variable state via `resolveServingContext` a single time, then applying it to
   * each routine, turns what would be N redundant reads into one. Action-capability authorization
   * and webhook-destination existence stay per-routine: the former depends on each routine's own
   * action steps, the latter on each routine's own `completionExport.destinationRef`.
   */
  async validateManyForServing(
    workspaceId: string,
    routines: readonly RoutineDefinition[],
  ): Promise<Map<string, RoutineValidationResult>> {
    if (routines.length === 0) {
      return new Map();
    }
    const agentId = routines[0].agentId;
    if (routines.some((routine) => routine.agentId !== agentId)) {
      throw new Error("validateManyForServing requires every routine to belong to the same agent");
    }
    const context = await this.resolveServingContext(workspaceId, agentId);
    const entries = await Promise.all(routines.map(async (routine) => {
      const structural = validateRoutineDefinition(routine, context);
      const actionValidation = await this.validateActionAuthorization(workspaceId, routine, structural);
      const result = await this.validateServingReferences(workspaceId, routine, actionValidation);
      return [routine.id, result] as const;
    }));
    return new Map(entries);
  }

  /**
   * Best-effort, matching `triggerEmbeddingService.persistPublished`'s own contract: the routine
   * write already committed by the time this runs, so a transient audit-sink failure must not
   * turn an already-saved edit into a reported error — that would tell an operator their save
   * failed when their data is already correct, and the natural response (retry) risks a
   * duplicate. Log the miss for support correlation instead of losing it silently.
   */
  private async recordAuthoringAudit(
    eventType: AuditEventInput["eventType"],
    workspaceId: string,
    agentId: string,
    routine: RoutineDefinition,
  ): Promise<void> {
    try {
      await this.options.auditService?.record({
        workspaceId,
        eventType,
        eventStatus: "success",
        metadata: {
          agentId,
          routineId: routine.id,
          lineageId: routine.lineageId,
          enabled: routine.enabled,
        },
      });
    } catch (error) {
      this.options.logger?.warn(
        { workspaceId, agentId, routineId: routine.id, eventType, error },
        "Routine authoring audit record failed",
      );
    }
  }

  private async validateActionAuthorization(
    workspaceId: string,
    routine: RoutineDefinition,
    validation: RoutineValidationResult,
  ): Promise<RoutineValidationResult> {
    if (!this.options.actionCapabilities) {
      return validation;
    }

    const diagnostics: RoutineValidationDiagnostic[] = [...validation.diagnostics];
    for (const step of routine.steps) {
      if (step.kind !== "action" || !step.actionType) {
        continue;
      }
      if (!this.options.actionCapabilities.has(step.actionType)) {
        diagnostics.push({
          code: "unregistered_action_type",
          location: `step:${step.stableStepId}`,
          message: `unregistered action type: action step "${step.stableStepId}" references "${step.actionType}", but no action handler is registered for that type.`,
        });
        continue;
      }

      for (const capability of this.options.actionCapabilities.requiredCapabilitiesFor(step.actionType)) {
        const decision = await this.capabilityPolicy.can({ capability, workspaceId });
        if (!decision.allowed) {
          diagnostics.push({
            code: "action_capability_denied",
            location: `step:${step.stableStepId}`,
            message: `action capability denied: action "${step.actionType}" requires capability "${capability}" for this workspace.`,
          });
        }
      }
    }

    return { ok: diagnostics.length === 0, diagnostics };
  }

  private async validateServingReferences(
    workspaceId: string,
    routine: RoutineDefinition,
    validation: RoutineValidationResult,
  ): Promise<RoutineValidationResult> {
    const diagnostics: RoutineValidationDiagnostic[] = [...validation.diagnostics];
    const completionExport = routine.completionExport;
    if (!completionExport?.enabled || completionExport.destinationRef.trim().length === 0) {
      return { ok: diagnostics.length === 0, diagnostics };
    }
    const destinationRef = completionExport.destinationRef.trim();
    if (!isUuid(destinationRef)) {
      diagnostics.push(invalidWebhookDestinationDiagnostic(destinationRef));
      return { ok: false, diagnostics };
    }
    if (!this.options.webhookDestinations) {
      return { ok: diagnostics.length === 0, diagnostics };
    }
    const exists = await this.options.webhookDestinations.existsByIdAndWorkspace(
      workspaceId,
      destinationRef.toLowerCase(),
    );
    if (!exists) {
      diagnostics.push(unknownWebhookDestinationDiagnostic(destinationRef));
    }
    return { ok: diagnostics.length === 0, diagnostics };
  }
}
