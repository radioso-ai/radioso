import { z } from "zod";

import type { CopilotContextVariableProposalAdapter } from "./contracts.js";
import type {
  AgentContextVariableEnablement,
  ContextVariable,
  ContextVariableOption,
  ContextVariableService,
} from "../context-variables/public.js";
import { isStale } from "./proposalVersioning.js";
import { badRequest, conflict, notFound } from "../../shared/domain/errors.js";

// Proposal shape remains Ray-owned; the context-variable module validates the
// resulting full enablement before drafts and applies can persist it.
const contextVariableValueTypes = ["string", "json", "enum"] as const;
const contextVariableTrustTiers = ["unverified", "signed"] as const;
const contextVariableSensitivities = ["normal", "sensitive"] as const;
const contextVariableSurfacings = ["always", "on_reference", "operator_only"] as const;
const contextVariableSources = ["pushed", "browser", "resolver", "request"] as const;
// includesDefinition/includesEnablement are optional so a targetRef persisted before this field
// existed still parses; readCurrentVersionParts treats an absent flag as "true" (the old,
// coarser behavior of always gating on both rows) rather than as "false". See the comment on
// readVersionToken for why the version token needs this at all.
const contextVariableTargetRefSchema = z.object({
  agentId: z.string().uuid(),
  variableId: z.string().uuid().nullable(),
  includesDefinition: z.boolean().optional(),
  includesEnablement: z.boolean().optional(),
}).strict();
const contextVariableEnablementInputSchema = z.object({
  source: z.enum(contextVariableSources),
  resolverSkillId: z.string().uuid().nullable().optional(),
  maxAgeSeconds: z.number().int().nonnegative().nullable().optional(),
  resolverTimeoutMs: z.number().int().positive().nullable().optional(),
  surfacing: z.enum(contextVariableSurfacings),
  enabled: z.boolean().optional(),
}).strict();
// An enum's options as Ray drafts them; the context-variable module checks keys, labels and limits.
const contextVariableOptionInputSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string().nullable().optional(),
  archived: z.boolean().optional(),
}).strict();
const contextVariableOptionStoredSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  archived: z.boolean(),
}).strict();
const contextVariableProposalPayloadSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2_000).nullable().optional(),
  valueType: z.enum(contextVariableValueTypes).optional(),
  options: z.array(contextVariableOptionInputSchema).nullable().optional(),
  trustTier: z.enum(contextVariableTrustTiers).optional(),
  sensitivity: z.enum(contextVariableSensitivities).optional(),
  defaultSurfacing: z.enum(contextVariableSurfacings).optional(),
  enablement: contextVariableEnablementInputSchema.optional(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
}).strict();
// `options` is optional so a proposal stored before enum variables existed still parses.
const contextVariableDefinitionStoredSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  valueType: z.enum(contextVariableValueTypes),
  options: z.array(contextVariableOptionStoredSchema).nullable().optional(),
  trustTier: z.enum(contextVariableTrustTiers),
  sensitivity: z.enum(contextVariableSensitivities),
  defaultSurfacing: z.enum(contextVariableSurfacings),
}).strict();
const contextVariableEnablementStoredSchema = z.object({
  source: z.enum(contextVariableSources),
  resolverSkillId: z.string().uuid().nullable(),
  maxAgeSeconds: z.number().int().nonnegative().nullable(),
  resolverTimeoutMs: z.number().int().positive().nullable(),
  surfacing: z.enum(contextVariableSurfacings),
  enabled: z.boolean(),
}).strict();
const contextVariableStoredPayloadSchema = z.object({
  name: z.string(),
  definition: contextVariableDefinitionStoredSchema.nullable(),
  enablement: contextVariableEnablementStoredSchema.nullable(),
  rationale: z.string().optional(),
}).strict();

/**
 * A context-variable proposal's version token encodes two independently-versioned timestamps
 * (the variable's own `updatedAt`, and this agent's enablement `updatedAt`) rather than the
 * single ISO string every other target type's token is. See the comment on
 * readCurrentVersionParts for why a single combined value can't do this job.
 *
 * Either side is `null` both when the underlying row does not exist yet (a brand-new variable's
 * enablement, say) and when the proposal this token belongs to never touches that side at all
 * (an enablement-only update to an existing variable's `variableUpdatedAt`). The two cases share
 * an encoding on purpose: Apply already ignores whichever half its own payload does not write
 * (`applyProposal` only checks `expectedVariableUpdatedAt`/`expectedEnablementUpdatedAt` when the
 * matching `definition`/`enablement` input is present), so a GET-time recompute of this token
 * needs to omit that same half to agree with Apply about what "stale" means - otherwise a
 * definition-only proposal drafted after an unrelated enablement edit would report stale here
 * while still applying successfully.
 *
 * The variable half is not always a Date: a create names no row of its own to read one from, so
 * its half is instead the opaque string contextVariableCreateToken produces. That's safe to mix
 * in here because applyIfVersionMatches never decodes this half back into a Date for a create -
 * expectedVariableUpdatedAt is unconditionally null there (variableId is null; there is no prior
 * row to version-gate against) - so decodeContextVariableVersionToken only ever needs to split
 * this half out, never parse it.
 */
const encodeContextVariableVersionToken = (variablePart: Date | string | null, enablementUpdatedAt: Date | null): string =>
  `${typeof variablePart === "string" ? variablePart : variablePart ? variablePart.toISOString() : ""}|${enablementUpdatedAt ? enablementUpdatedAt.toISOString() : ""}`;

/**
 * The definition half of a create proposal's token: which existing variable (if any) already
 * occupies the workspace+name identity a fresh insert would take - the
 * context_variables_workspace_id_name_key constraint applyProposal's own catch translates into a
 * conflict (see isContextVariableNameConflict in contextVariableRepository.ts) - or "open" when
 * none does. Read fresh both when a create proposal is drafted (to seed its stored token) and
 * again at GET time (to recompute it), so the two only diverge when that specific conflict
 * changes - never from an unrelated agent edit.
 */
const contextVariableCreateToken = (blocking: ContextVariable | null): string =>
  blocking ? `blocked:${blocking.id}:${blocking.updatedAt.toISOString()}` : "open";

const decodeContextVariableVersionToken = (token: string): { variableUpdatedAt: Date | null; enablementUpdatedAt: Date | null } => {
  const [variablePart, enablementPart] = token.split("|");
  return {
    variableUpdatedAt: variablePart ? new Date(variablePart) : null,
    enablementUpdatedAt: enablementPart ? new Date(enablementPart) : null,
  };
};

interface NormalizedContextVariableDefinition {
  readonly name: string;
  readonly description: string | null;
  readonly valueType: ContextVariable["valueType"];
  readonly options: readonly ContextVariableOption[] | null;
  readonly trustTier: ContextVariable["trustTier"];
  readonly sensitivity: ContextVariable["sensitivity"];
  readonly defaultSurfacing: ContextVariable["defaultSurfacing"];
}

interface NormalizedContextVariableEnablement {
  readonly source: AgentContextVariableEnablement["source"];
  readonly resolverSkillId: string | null;
  readonly maxAgeSeconds: number | null;
  readonly resolverTimeoutMs: number | null;
  readonly surfacing: AgentContextVariableEnablement["surfacing"];
  readonly enabled: boolean;
}

const findAgentContextVariableEnablement = async (
  contextVariables: Pick<ContextVariableService, "listByAgent">,
  workspaceId: string,
  agentId: string,
  variableId: string | null,
): Promise<AgentContextVariableEnablement | null> => {
  if (!variableId) return null;
  const enablements = await contextVariables.listByAgent(workspaceId, agentId);
  return enablements.find((enablement) => enablement.variableId === variableId) ?? null;
};

/**
 * Composition adapter: a context variable's workspace-scoped definition and one agent's
 * enablement of it are two separate resources this adapter can create or update from a single
 * proposal. Ray supplies concrete field values it already read (from the context_variables
 * reader), never a draft from prose, so validation happens entirely in `validatePayload` — the
 * same shape as propose_skill_config.
 */
const normalizeOptions = (
  options: ReadonlyArray<z.infer<typeof contextVariableOptionInputSchema>> | null,
): readonly ContextVariableOption[] | null =>
  options?.map((option) => ({
    key: option.key,
    label: option.label,
    description: option.description ?? null,
    archived: option.archived ?? false,
  })) ?? null;

export const createContextVariableCopilotProposalAdapter = (deps: {
  readonly contextVariables: Pick<ContextVariableService, "get" | "listByAgent" | "listByWorkspace" | "requireAgent" | "assertDefinitionTypeFits" | "assertEnablementReferences" | "applyProposal">;
}): CopilotContextVariableProposalAdapter => {
  const findEnablement = (workspaceId: string, agentId: string, variableId: string | null) =>
    findAgentContextVariableEnablement(deps.contextVariables, workspaceId, agentId, variableId);

  const findBlockingVariable = async (workspaceId: string, name: string): Promise<ContextVariable | null> => {
    const variables = await deps.contextVariables.listByWorkspace(workspaceId);
    return variables.find((variable) => variable.name === name) ?? null;
  };

  /** Projects a stored definition/enablement down to the same editable shape a proposal's
   * payload carries, so a preview diff shows only fields a proposal can actually change - not
   * identity/audit columns (id, workspaceId, createdAt, updatedAt, ...) that would otherwise
   * render as spurious "removed" rows next to a payload that never carried them. */
  const projectDefinitionForPreview = (definition: Pick<ContextVariable, "name" | "description" | "valueType" | "options" | "trustTier" | "sensitivity" | "defaultSurfacing">) => ({
    name: definition.name,
    description: definition.description,
    valueType: definition.valueType,
    options: definition.options,
    trustTier: definition.trustTier,
    sensitivity: definition.sensitivity,
    defaultSurfacing: definition.defaultSurfacing,
  });
  const projectEnablementForPreview = (enablement: Pick<AgentContextVariableEnablement, "source" | "resolverSkillId" | "maxAgeSeconds" | "resolverTimeoutMs" | "surfacing" | "enabled">) => ({
    source: enablement.source,
    resolverSkillId: enablement.resolverSkillId,
    maxAgeSeconds: enablement.maxAgeSeconds,
    resolverTimeoutMs: enablement.resolverTimeoutMs,
    surfacing: enablement.surfacing,
    enabled: enablement.enabled,
  });

  // A proposal can touch the definition, the enablement, or both — two independently-versioned
  // rows behind a single proposal. A single `max(...)` timestamp token can't be decomposed back
  // into two per-row expectations (whichever side did NOT change would still fail its own
  // WHERE-clause guard when the token derives from the other side's later timestamp), so the
  // token carries both timestamps explicitly instead.
  /** For an existing variable only; a create has no row of its own to read from - see readVersionToken's create branch. */
  const readCurrentVersionParts = async (
    workspaceId: string,
    targetRef: { agentId: string; variableId: string },
  ): Promise<{ variableUpdatedAt: Date; enablementUpdatedAt: Date | null }> => {
    // The module service resolves the agent through its workspace before reading the
    // version parts, preserving tenant ownership independently of the database FK.
    await deps.contextVariables.requireAgent(workspaceId, targetRef.agentId);
    const variable = await deps.contextVariables.get(workspaceId, targetRef.variableId);
    if (!variable) throw notFound("Context variable no longer exists");
    const enablement = await findEnablement(workspaceId, targetRef.agentId, targetRef.variableId);
    return { variableUpdatedAt: variable.updatedAt, enablementUpdatedAt: enablement?.updatedAt ?? null };
  };

  const resolveProposal = async (workspaceId: string, targetRef: { agentId: string; variableId: string | null }, rawPayload: unknown) => {
    const payload = contextVariableProposalPayloadSchema.parse(rawPayload);
    // Resolved for its own sake: a proposal always scopes to an agent (even a definition-only
    // one), so an unresolvable agent id must fail here rather than only surfacing once the
    // enablement write is attempted. Not used for the version token below - see the comment on
    // contextVariableCreateToken for what a create's half is derived from instead.
    await deps.contextVariables.requireAgent(workspaceId, targetRef.agentId);
    const existing = targetRef.variableId ? await deps.contextVariables.get(workspaceId, targetRef.variableId) : null;
    if (targetRef.variableId && !existing) throw notFound("Context variable not found");
    // Read in the same pass as `existing`, both to close the same stale-read window Finding 1
    // closes for the definition side, and because it doubles as the version-token anchor for an
    // enablement-only proposal (see the versionToken computation below).
    const existingEnablement = await findEnablement(workspaceId, targetRef.agentId, targetRef.variableId);

    const hasDefinitionFields = payload.name !== undefined || payload.description !== undefined
      || payload.valueType !== undefined || payload.options !== undefined || payload.trustTier !== undefined
      || payload.sensitivity !== undefined || payload.defaultSurfacing !== undefined;
    if (!existing && !hasDefinitionFields) {
      throw badRequest("A new context variable needs a name, value type, trust tier, sensitivity, and default surfacing");
    }
    if (!hasDefinitionFields && !payload.enablement) {
      throw badRequest("Propose a variable definition change, an agent enablement change, or both");
    }

    let definition: NormalizedContextVariableDefinition | null = null;
    if (hasDefinitionFields || !existing) {
      const name = payload.name ?? existing?.name;
      const valueType = payload.valueType ?? existing?.valueType;
      const trustTier = payload.trustTier ?? existing?.trustTier;
      const sensitivity = payload.sensitivity ?? existing?.sensitivity;
      const defaultSurfacing = payload.defaultSurfacing ?? existing?.defaultSurfacing;
      if (!name) throw badRequest("A context variable name is required to propose a new variable");
      if (!valueType) throw badRequest("A value type is required to propose a new variable");
      if (!trustTier) throw badRequest("A trust tier is required to propose a new variable");
      if (!sensitivity) throw badRequest("A sensitivity is required to propose a new variable");
      if (!defaultSurfacing) throw badRequest("A default surfacing is required to propose a new variable");
      definition = {
        name,
        description: "description" in payload ? payload.description ?? null : existing?.description ?? null,
        valueType,
        // Options the proposal leaves out stay as stored while the type stays.
        options: payload.options !== undefined
          ? normalizeOptions(payload.options)
          : valueType === existing?.valueType ? existing.options : null,
        trustTier,
        sensitivity,
        defaultSurfacing,
      };
      await deps.contextVariables.assertDefinitionTypeFits(existing, definition);

      // A create, or a rename, that would collide with another variable's workspace+name identity
      // (context_variables_workspace_id_name_key) can never apply - refusing it here, at draft
      // time, is what keeps that always-doomed proposal from ever becoming a pending card (Findings
      // 1-2, next-ray-epic-issue review). Skipped when the name is unchanged so an update that
      // leaves it alone never pays for this read. A blocker that appears only *after* this check -
      // racing a create (contextVariableCreateToken, read fresh again at GET time) or a rename
      // (applyProposal's own translated unique-constraint conflict) - is still caught, just later.
      if (name !== existing?.name) {
        const blocking = await findBlockingVariable(workspaceId, name);
        if (blocking && blocking.id !== existing?.id) {
          throw conflict(`A context variable named "${name}" already exists for this workspace`);
        }
      }
    }

    let enablement: NormalizedContextVariableEnablement | null = null;
    if (payload.enablement) {
      const rawEnablement = payload.enablement;
      // ApplyContextVariableProposalInput.enablement is a full-row replacement (see
      // ContextVariableEnablementWrite), so a proposal that restates only the fields it means to
      // change has to be merged against the stored row here, field by field, before it reaches
      // that write - otherwise every omitted field (staleness/timeout tuning, a deliberate
      // `enabled: false`) would silently reset. An absent key means "keep the stored value"; an
      // explicit `null` means "clear it" - `"key" in rawEnablement` is the presence test (Zod
      // does not materialize an absent `.optional()` key as `undefined`, verified separately),
      // so `??` alone can't tell those two cases apart.
      const mergedSource = rawEnablement.source;
      // Resolver-only fields (resolverSkillId/maxAgeSeconds/resolverTimeoutMs) only survive the
      // merge when BOTH the proposed and the stored source are "resolver" - carrying them forward
      // across a source change (e.g. resolver -> pushed) would resurrect exactly the
      // contradictory/inert combination assertEnablementIsWellFormed exists to forbid.
      const carriesResolverFields = mergedSource === "resolver" && existingEnablement?.source === "resolver";
      const mergedResolverSkillId = "resolverSkillId" in rawEnablement
        ? rawEnablement.resolverSkillId ?? null
        : (carriesResolverFields ? existingEnablement.resolverSkillId : null);
      const mergedMaxAgeSeconds = "maxAgeSeconds" in rawEnablement
        ? rawEnablement.maxAgeSeconds ?? null
        : (carriesResolverFields ? existingEnablement.maxAgeSeconds : null);
      const mergedResolverTimeoutMs = "resolverTimeoutMs" in rawEnablement
        ? rawEnablement.resolverTimeoutMs ?? null
        : (carriesResolverFields ? existingEnablement.resolverTimeoutMs : null);
      // `enabled` carries forward regardless of source (it is not resolver-only), and only
      // defaults to `true` when there is no stored enablement at all - this is the headline fix:
      // a deliberately-disabled variable must never come back on just because an unrelated field
      // changed.
      const mergedEnabled = "enabled" in rawEnablement && rawEnablement.enabled !== undefined
        ? rawEnablement.enabled
        : (existingEnablement?.enabled ?? true);

      const mergedEnablement: NormalizedContextVariableEnablement = {
        source: mergedSource,
        resolverSkillId: mergedResolverSkillId,
        maxAgeSeconds: mergedMaxAgeSeconds,
        resolverTimeoutMs: mergedResolverTimeoutMs,
        surfacing: rawEnablement.surfacing,
        enabled: mergedEnabled,
      };
      // Checked on the MERGED object, not the raw payload: a proposal that only names
      // `resolverSkillId` in the resolver-inheritance branch above is legitimately incomplete on
      // its own (it relies on a still-resolver stored source to fill the rest in), so asserting
      // the raw payload here would reject a merge this function is meant to allow. Any way the
      // merge could still produce a contradictory/inert combination is caught by the
      // context-variable service here instead.
      await deps.contextVariables.assertEnablementReferences(
        workspaceId,
        targetRef.agentId,
        targetRef.variableId,
        mergedEnablement,
      );
      enablement = mergedEnablement;
    }

    // Scoped to what this proposal actually writes (Apply already does the same - see the
    // comment on encodeContextVariableVersionToken), computed from the exact reads above rather
    // than a follow-up readVersionToken call, so a concurrent edit landing between two separate
    // reads can't pair an expansion built from the first (stale) read with a token from the
    // second, fresher one. For a create, see the comment on contextVariableCreateToken for why
    // this isn't the agent's updatedAt either.
    const includesDefinition = definition !== null;
    const includesEnablement = enablement !== null;
    const proposalVersionToken = encodeContextVariableVersionToken(
      includesDefinition ? (existing ? existing.updatedAt : contextVariableCreateToken(await findBlockingVariable(workspaceId, definition!.name))) : null,
      includesEnablement ? (existingEnablement?.updatedAt ?? null) : null,
    );

    return {
      existing,
      includesDefinition,
      includesEnablement,
      versionToken: proposalVersionToken,
      normalized: {
        name: definition?.name ?? existing!.name,
        definition,
        enablement,
        ...(payload.rationale ? { rationale: payload.rationale } : {}),
      },
    };
  };

  return {
    targetType: "context_variable",
    proposalDetailTargetRef: (rawTargetRef) => {
      const targetRef = contextVariableTargetRefSchema.parse(rawTargetRef);
      return { agentId: targetRef.agentId, variableId: targetRef.variableId, includesDefinition: targetRef.includesDefinition ?? null, includesEnablement: targetRef.includesEnablement ?? null };
    },
    async readVersionToken(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = contextVariableTargetRefSchema.parse(rawTargetRef);
      if (!targetRef.variableId) {
        // A create names no row of its own to read a version from; see the comment on
        // contextVariableCreateToken for what determines staleness instead. The agent is still
        // resolved for its own sake (an unresolvable id must fail here, not only once Apply's
        // write is attempted). A create's enablement half is always null - see resolveProposal's
        // token computation for why.
        await deps.contextVariables.requireAgent(workspaceId, targetRef.agentId);
        const payload = contextVariableStoredPayloadSchema.parse(rawPayload);
        if (!payload.definition) throw new Error("A new context variable proposal has no definition to check for a conflict against");
        const blocking = await findBlockingVariable(workspaceId, payload.definition.name);
        return encodeContextVariableVersionToken(contextVariableCreateToken(blocking), null);
      }
      const parts = await readCurrentVersionParts(workspaceId, { agentId: targetRef.agentId, variableId: targetRef.variableId });
      // Called with only a targetRef (see getProposal), never the proposal's own payload, so the
      // targetRef itself is what has to say which half of the composite token this particular
      // proposal cares about - see the comment on contextVariableTargetRefSchema and on
      // encodeContextVariableVersionToken for why an absent flag means "both" rather than
      // "neither".
      return encodeContextVariableVersionToken(
        targetRef.includesDefinition === false ? null : parts.variableUpdatedAt,
        targetRef.includesEnablement === false ? null : parts.enablementUpdatedAt,
      );
    },
    async preview(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = contextVariableTargetRefSchema.parse(rawTargetRef);
      const payload = contextVariableStoredPayloadSchema.parse(rawPayload);
      const existing = targetRef.variableId ? await deps.contextVariables.get(workspaceId, targetRef.variableId) : null;
      const existingEnablement = await findEnablement(workspaceId, targetRef.agentId, targetRef.variableId);
      const currentDefinition = existing ? projectDefinitionForPreview(existing) : null;
      const currentEnablement = existingEnablement ? projectEnablementForPreview(existingEnablement) : null;
      return {
        targetLabel: payload.name,
        current: { definition: currentDefinition, enablement: currentEnablement },
        // `payload.definition`/`payload.enablement` is `null` when this proposal does not touch
        // that half, not "clear it" - falling back to the projected current value here (rather
        // than showing the stored proposal payload's literal `null`) keeps that half identical on
        // both sides of the diff, so buildCopilotProposalDiff renders nothing for it instead of
        // recursing through every field of `current` as a removal.
        proposed: { definition: payload.definition ?? currentDefinition, enablement: payload.enablement ?? currentEnablement },
      };
    },
    async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token) {
      const targetRef = contextVariableTargetRefSchema.parse(rawTargetRef);
      const payload = contextVariableStoredPayloadSchema.parse(rawPayload);
      try {
        // The context-variable service resolves the agent again inside applyProposal. That check
        // is not used to gate on updatedAt: a
        // create never touches the agent row, so comparing timestamps here could only ever
        // produce a false "stale" from an unrelated agent edit - never real protection against
        // replaying an apply that already succeeded. That protection comes from applyProposal's
        // own name-uniqueness violation below, translated into a real conflict.
        await deps.contextVariables.requireAgent(workspaceId, targetRef.agentId);
        const decoded = decodeContextVariableVersionToken(token);

        // Every version check is enforced inside applyProposal's own transaction (each write
        // gated by its own predicate, and only for the row its own input actually supplies), not
        // by a read-then-compare here: a pre-read leaves a window where a concurrent edit lands
        // between the check and the write.
        const result = await deps.contextVariables.applyProposal({
          workspaceId,
          agentId: targetRef.agentId,
          variableId: targetRef.variableId,
          definition: payload.definition ? { ...payload.definition, options: payload.definition.options ?? null } : null,
          expectedVariableUpdatedAt: targetRef.variableId ? decoded.variableUpdatedAt : null,
          enablement: payload.enablement,
          expectedEnablementUpdatedAt: decoded.enablementUpdatedAt,
        });
        return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId, variableId: result.variableId } };
      } catch (error) {
        if (isStale(error)) return { outcome: "stale" as const };
        return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Context variable apply failed" };
      }
    },
    async validatePayload(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = contextVariableTargetRefSchema.parse(rawTargetRef);
      const { normalized, includesDefinition, includesEnablement, versionToken: proposalVersionToken } = await resolveProposal(workspaceId, targetRef, rawPayload);
      return {
        targetRef: { ...targetRef, includesDefinition, includesEnablement },
        payload: normalized,
        versionToken: proposalVersionToken,
      };
    },
  };
};
