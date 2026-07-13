import { randomUUID } from "node:crypto";

import { badRequest, conflict, notFound } from "../../shared/domain/errors.js";
import { DefaultAllowCapabilityPolicy, type CapabilityPolicy } from "../../shared/domain/capabilityPolicy.js";
import type { ActionCapabilityMap } from "../../shared/domain/actionCapabilities.js";
import type { AuditEventInput, AuditPort } from "../audit/contracts/index.js";
import type { AgentContextVariableEnablement } from "../context-variables/public.js";
import { BUILT_IN_CONTEXT_VARIABLES } from "../context-variables/public.js";
import type { SkillAuthoringCatalog } from "../skills/public.js";
import {
  routineDefinitionDraftInputSchema,
  type RoutineDefinition,
  type RoutineDefinitionDraftInput,
  type RoutineDefinitionDraftAuthoringInput,
} from "./domain.js";
import { compileRoutineDefinition } from "./compiler.js";
import {
  validateRoutineDefinition,
  type RoutineValidationDiagnostic,
  type RoutineValidationResult,
} from "./validator.js";

export interface RoutineDefinitionRepositoryPort {
  listPublishedByAgent(agentId: string): Promise<RoutineDefinition[]>;
  listByAgent(agentId: string): Promise<RoutineDefinition[]>;
  findById(agentId: string, id: string): Promise<RoutineDefinition | null>;
  createDraft(agentId: string, input: RoutineDefinitionDraftInput): Promise<RoutineDefinition>;
  updateDraft(agentId: string, id: string, input: RoutineDefinitionDraftInput): Promise<RoutineDefinition>;
  publish(agentId: string, id: string, options?: RoutineDefinitionPublishOptions): Promise<RoutineDefinition>;
  createRevisionDraft(agentId: string, publishedId: string): Promise<RoutineDefinition | null>;
  archive(agentId: string, id: string): Promise<boolean>;
  restore(agentId: string, id: string): Promise<boolean>;
  deleteDraft(agentId: string, id: string): Promise<boolean>;
  listPublishedRoutineNamesReferencingDestination?(workspaceId: string, destinationId: string): Promise<string[]>;
}

export interface RoutineDefinitionSaveResult {
  routine: RoutineDefinition;
  validation: RoutineValidationResult;
}

export interface RoutineDirectiveScopeOrphan {
  directiveId: string;
  scopeTag: string;
  reason: "missing_step";
}

export interface RoutineDefinitionPublishLifecycleInput {
  previousPublishedId: string | null;
  newDefinitionId: string;
  transaction: unknown;
}

export interface RoutineDefinitionPublishOptions {
  onPublished?: (input: RoutineDefinitionPublishLifecycleInput) => Promise<void>;
}

export interface RoutineDefinitionPublishRejection {
  rejected: true;
  validation: RoutineValidationResult;
}

export type RoutineDefinitionPublishSuccess = RoutineDefinitionSaveResult & {
  directiveScopeOrphans: RoutineDirectiveScopeOrphan[];
};

export type RoutineDefinitionPublishResult = RoutineDefinitionPublishSuccess | RoutineDefinitionPublishRejection;

export interface RoutineDefinitionServiceOptions {
  agentRepository: {
    findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<unknown | null>;
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
   * Folded into the publish/validate allow-list so existing routines that use
   * them are not rejected as `unknown_skill`. Must mirror the runtime resolver's
   * name derivation (enabled skills only).
   */
  additionalRoutineSkillNames?: (input: {
    workspaceId: string;
    agentId: string;
  }) => Promise<readonly string[]>;
  auditService?: Pick<AuditPort, "record">;
  directiveScopeTags?: {
    repointRoutineScopeTags(input: {
      agentId: string;
      fromDefinitionId: string;
      toDefinitionId: string;
      survivingStepIds: ReadonlySet<string>;
      transaction?: unknown;
    }): Promise<{ repointed: number; orphans: RoutineDirectiveScopeOrphan[] }>;
  };
}

const draftDefinitionFromInput = (agentId: string, input: RoutineDefinitionDraftInput): RoutineDefinition => ({
  id: randomUUID(),
  agentId,
  lineageId: randomUUID(),
  version: 1,
  status: "draft",
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

const missingWebhookDestinationRefFromConstraintError = (error: unknown): string | null => {
  if (!error || typeof error !== "object") {
    return null;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") {
    return null;
  }
  const match = /unknown webhook destination ([0-9a-f-]{36})/iu.exec(message);
  return match?.[1] ?? null;
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
    const saved = await this.options.repository.createDraft(agentId, draft);
    return {
      routine: saved,
      validation: validateRoutineDefinition(saved),
    };
  }

  async updateDraft(
    workspaceId: string,
    agentId: string,
    id: string,
    input: RoutineDefinitionDraftAuthoringInput,
  ): Promise<RoutineDefinitionSaveResult> {
    await this.requireAgent(workspaceId, agentId);
    const existing = await this.requireRoutine(agentId, id);
    if (existing.status !== "draft") {
      throw badRequest("Only draft routine definitions can be updated");
    }
    const draft = this.validateInput(input);
    let saved: RoutineDefinition;
    try {
      saved = await this.options.repository.updateDraft(agentId, id, draft);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("routine_definition_update_conflict:")) {
        throw conflict("Routine was published concurrently — revise it to continue editing");
      }
      throw error;
    }
    return {
      routine: saved,
      validation: validateRoutineDefinition(saved),
    };
  }

  async validate(
    workspaceId: string,
    agentId: string,
    target: { id: string } | { input: RoutineDefinitionDraftAuthoringInput },
  ): Promise<RoutineValidationResult> {
    await this.requireAgent(workspaceId, agentId);
    if ("id" in target) {
      const routine = await this.requireRoutine(agentId, target.id);
      const validation = await this.validateWithAvailableSkills(workspaceId, routine);
      return this.validatePublishReferences(workspaceId, routine, validation);
    }
    const draft = this.validateInput(target.input);
    const routine = draftDefinitionFromInput(agentId, draft);
    const validation = await this.validateWithAvailableSkills(workspaceId, routine);
    return this.validatePublishReferences(workspaceId, routine, validation);
  }

  async publish(workspaceId: string, agentId: string, id: string): Promise<RoutineDefinitionPublishResult> {
    await this.requireAgent(workspaceId, agentId);
    const routine = await this.requireRoutine(agentId, id);
    if (routine.status !== "draft") {
      throw badRequest("Only draft routine definitions can be published");
    }
    const validation = await this.validateWithAvailableSkills(workspaceId, routine);
    if (!validation.ok) {
      return { rejected: true, validation };
    }
    const actionValidation = await this.validateActionAuthorization(workspaceId, routine, validation);
    if (!actionValidation.ok) {
      return { rejected: true, validation: actionValidation };
    }
    const referenceValidation = await this.validatePublishReferences(workspaceId, routine, actionValidation);
    if (!referenceValidation.ok) {
      return { rejected: true, validation: referenceValidation };
    }
    compileRoutineDefinition(routine);
    let published: RoutineDefinition;
    let directiveScopeOrphans: RoutineDirectiveScopeOrphan[] = [];
    let supersededDefinitionId: string | null = null;
    const survivingStepIds = new Set(routine.steps.map((step) => step.stableStepId));
    try {
      published = await this.options.repository.publish(agentId, id, {
        onPublished: async ({ previousPublishedId, newDefinitionId, transaction }) => {
          supersededDefinitionId = previousPublishedId;
          if (!previousPublishedId || !this.options.directiveScopeTags) {
            return;
          }
          const repointResult = await this.options.directiveScopeTags.repointRoutineScopeTags({
            agentId,
            fromDefinitionId: previousPublishedId,
            toDefinitionId: newDefinitionId,
            survivingStepIds,
            transaction,
          });
          directiveScopeOrphans = repointResult.orphans;
        },
      });
    } catch (error) {
      if (isRoutineCompletionExportDestinationConstraintError(error) && routine.completionExport?.enabled) {
        return {
          rejected: true,
          validation: {
            ok: false,
            diagnostics: [
              ...referenceValidation.diagnostics,
              unknownWebhookDestinationDiagnostic(routine.completionExport.destinationRef.trim()),
            ],
          },
        };
      }
      throw error;
    }
    await this.recordLifecycleAudit("routine_definition.publish", workspaceId, agentId, published, {
      supersededDefinitionId,
      directiveScopeOrphans: directiveScopeOrphans.length,
    });
    return {
      routine: published,
      validation: await this.validateWithAvailableSkills(workspaceId, published),
      directiveScopeOrphans,
    };
  }

  async revise(workspaceId: string, agentId: string, id: string): Promise<RoutineDefinition> {
    await this.requireAgent(workspaceId, agentId);
    const routine = await this.requireRoutine(agentId, id);
    if (routine.status !== "published") {
      throw badRequest("Only published routine definitions can be revised");
    }
    const revision = await this.options.repository.createRevisionDraft(agentId, id);
    if (!revision) {
      throw notFound("Published routine definition not found");
    }
    await this.recordLifecycleAudit("routine_definition.revise", workspaceId, agentId, revision);
    return revision;
  }

  async archive(workspaceId: string, agentId: string, id: string): Promise<RoutineDefinition> {
    await this.requireAgent(workspaceId, agentId);
    const routine = await this.requireRoutine(agentId, id);
    if (routine.status !== "published") {
      throw badRequest("Only published routine definitions can be archived");
    }
    const archived = await this.options.repository.archive(agentId, id);
    if (!archived) {
      throw notFound("Published routine definition not found");
    }
    const updated = await this.requireRoutine(agentId, id);
    await this.recordLifecycleAudit("routine_definition.archive", workspaceId, agentId, updated);
    return updated;
  }

  async restore(workspaceId: string, agentId: string, id: string): Promise<RoutineDefinition> {
    await this.requireAgent(workspaceId, agentId);
    const routine = await this.requireRoutine(agentId, id);
    if (routine.status !== "archived") {
      throw badRequest("Only archived routine definitions can be restored");
    }
    let restored: boolean;
    try {
      restored = await this.options.repository.restore(agentId, id);
    } catch (error) {
      if (isRoutineCompletionExportDestinationConstraintError(error)) {
        const destinationRef = missingWebhookDestinationRefFromConstraintError(error) ?? routine.completionExport?.destinationRef ?? "configured destination";
        throw badRequest(`Archived routine definition cannot be restored because completion export references missing webhook destination ${destinationRef}`);
      }
      throw error;
    }
    if (!restored) {
      throw badRequest("Archived routine definition cannot be restored while another version is published");
    }
    const updated = await this.requireRoutine(agentId, id);
    await this.recordLifecycleAudit("routine_definition.restore", workspaceId, agentId, updated);
    return updated;
  }

  async deleteDraft(workspaceId: string, agentId: string, id: string): Promise<void> {
    await this.requireAgent(workspaceId, agentId);
    const deleted = await this.options.repository.deleteDraft(agentId, id);
    if (!deleted) {
      throw notFound("Draft routine definition not found");
    }
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

  private async validateWithAvailableSkills(
    workspaceId: string,
    routine: RoutineDefinition,
  ): Promise<RoutineValidationResult> {
    if (!this.options.skillAuthoringCatalog) {
      return validateRoutineDefinition(routine);
    }
    const [descriptors, additionalNames, contextVariables] = await Promise.all([
      this.options.skillAuthoringCatalog.listForAgent({ workspaceId, agentId: routine.agentId }),
      this.options.additionalRoutineSkillNames?.({ workspaceId, agentId: routine.agentId }) ?? Promise.resolve([]),
      this.options.contextVariableReader?.listByAgent(workspaceId, routine.agentId) ?? Promise.resolve([]),
    ]);
    return validateRoutineDefinition(routine, {
      // The catalog covers built-in + external skills (which also carry typed
      // descriptors); webhook/customer-email skills are runtime-resolvable but
      // not catalogued, so add their names to the allow-list to avoid false
      // `unknown_skill` rejections at publish.
      availableSkillNames: new Set([
        ...descriptors.map((descriptor) => descriptor.skillName),
        ...additionalNames,
      ]),
      skillDescriptors: new Map(descriptors.map((descriptor) => [descriptor.skillName, descriptor])),
      availableContextVariables: new Map([
        ...BUILT_IN_CONTEXT_VARIABLES.map((variable) => [variable.name, { valueType: variable.valueType }] as const),
        ...contextVariables
          .filter((enablement): enablement is AgentContextVariableEnablement & { variable: NonNullable<AgentContextVariableEnablement["variable"]> } =>
            enablement.enabled && enablement.variable !== undefined
          )
          .map((enablement) => [
            enablement.variable.name,
            { valueType: enablement.variable.valueType },
          ] as const),
      ]),
    });
  }

  private async recordLifecycleAudit(
    eventType: AuditEventInput["eventType"],
    workspaceId: string,
    agentId: string,
    routine: RoutineDefinition,
    extraMetadata: Record<string, string | number | null> = {},
  ): Promise<void> {
    await this.options.auditService?.record({
      workspaceId,
      eventType,
      eventStatus: "success",
      metadata: {
        agentId,
        routineId: routine.id,
        lineageId: routine.lineageId,
        version: routine.version,
        status: routine.status,
        ...extraMetadata,
      },
    });
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

  private async validatePublishReferences(
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
