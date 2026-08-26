import { z } from "zod";

import {
  AuthoredDirectiveService,
  DirectiveAuthorService,
  AgentService,
  mergeAgentSurfaceSettings,
  validateAgentInput,
  type AgentInput,
  type AuthoredDirectiveInput,
} from "../../modules/agents/public.js";
import {
  applyRoutineFieldPatch,
  describeRoutineFieldPatch,
  projectRoutineForReview,
  routineDefinitionDraftInputSchema,
  routineFieldPatchSchema,
  type RoutineDefinition,
  type RoutineDefinitionService,
  type RoutineDraftAssistService,
  type RoutineValidationDiagnostic,
} from "../../modules/routines/public.js";
import type {
  CopilotAgentSettingProposalAdapter,
  CopilotDirectiveProposalAdapter,
  CopilotRoutineLifecycleAction,
  CopilotRoutineProposalAdapter,
} from "../../modules/operatorCopilot/public.js";
import { AppError } from "../../shared/domain/errors.js";

const directiveTargetRefSchema = z.object({ agentId: z.string().uuid(), directiveId: z.string().uuid().nullable() }).strict();
const settingTargetRefSchema = z.object({ agentId: z.string().uuid(), settingKey: z.string().min(1).max(200) }).strict();
const routineTargetRefSchema = z.object({ agentId: z.string().uuid(), routineId: z.string().uuid().nullable() }).strict();
const routineLifecycleActions = ["publish", "archive", "restore"] as const;
// The card summary is rebuilt from `payload.rationale` after a reload, which is why every routine
// payload carries the drafted summary under that name rather than only Ray's own words.
const routineEditPayloadSchema = z.object({
  kind: z.literal("edit"),
  name: z.string(),
  changes: routineFieldPatchSchema,
  rationale: z.string().optional(),
}).strict();
const routineLifecyclePayloadSchema = z.object({
  kind: z.literal("lifecycle"),
  action: z.enum(routineLifecycleActions),
  name: z.string(),
  rationale: z.string().optional(),
  /** The draft revision archiving deletes, as disclosed when the proposal was drafted. */
  discardsDraftRevisionId: z.string().uuid().optional(),
  /** Its version at that moment, so an edit made to it since is not thrown away unannounced. */
  discardsDraftRevisionUpdatedAt: z.string().optional(),
}).strict();
// Payloads written before routine edits existed carry no `kind`; an absent one is a new-routine draft.
const routinePayloadKind = (payload: unknown): "edit" | "lifecycle" | "create" => {
  const kind = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>).kind : undefined;
  return kind === "edit" || kind === "lifecycle" ? kind : "create";
};
// A draft is edited in place and a published routine is revised into one first. Anything else —
// archived, or a version something newer superseded — has no draft to edit.
const editableRoutineStatus = (routine: Pick<RoutineDefinition, "status">): boolean =>
  routine.status === "draft" || routine.status === "published";
const uneditableRoutineReason = (routine: Pick<RoutineDefinition, "name" | "status">): string =>
  `Routine ${routine.name} is ${routine.status}. Restore an archived routine, or edit the current version, before proposing changes.`;
const requiredRoutineId = (targetRef: { routineId: string | null }): string => {
  if (!targetRef.routineId) throw new Error("This routine proposal names no routine");
  return targetRef.routineId;
};
const routineStatusForAction: Record<CopilotRoutineLifecycleAction, RoutineDefinition["status"]> = {
  publish: "draft",
  archive: "published",
  restore: "archived",
};
const routineStatusAfterAction: Record<CopilotRoutineLifecycleAction, RoutineDefinition["status"]> = {
  publish: "published",
  archive: "archived",
  restore: "published",
};
/** Publish and restore both end with the routine serving customers; archive takes it out of play. */
const goesLive = (action: CopilotRoutineLifecycleAction): boolean => action !== "archive";
const routineActionVerb: Record<CopilotRoutineLifecycleAction, string> = {
  publish: "Publish",
  archive: "Archive",
  restore: "Restore",
};
const diagnosticSummary = (diagnostics: ReadonlyArray<RoutineValidationDiagnostic>): string =>
  diagnostics.map((diagnostic) => diagnostic.message).join(" ");
const withRationale = (summary: string, rationale?: string): string => rationale ? `${summary} ${rationale}` : summary;
const settingPayloadSchema = z.object({ value: z.unknown(), rationale: z.string().min(1).max(1_000).optional() }).strict();

/** Composition adapter: drafts through the existing coach and writes only through authored-directive management. */
export const createDirectiveCopilotProposalAdapter = (deps: {
  readonly authoredDirectiveService: Pick<AuthoredDirectiveService, "list" | "create" | "update">;
  readonly directiveAuthorService: Pick<DirectiveAuthorService, "draft">;
  readonly agentService: Pick<AgentService, "get">;
}): CopilotDirectiveProposalAdapter => ({
  targetType: "directive",
  async readVersionToken(workspaceId, rawTargetRef) {
    const targetRef = directiveTargetRefSchema.parse(rawTargetRef);
    if (!targetRef.directiveId) return versionToken((await deps.agentService.get(workspaceId, targetRef.agentId)).updatedAt);
    const directive = (await deps.authoredDirectiveService.list(workspaceId, targetRef.agentId)).find((item) => item.id === targetRef.directiveId);
    if (!directive) throw new Error("Directive no longer exists");
    return versionToken(directive.updatedAt);
  },
  async preview(workspaceId, rawTargetRef, payload) {
    const targetRef = directiveTargetRefSchema.parse(rawTargetRef);
    const proposed = directivePayload(payload);
    const current = targetRef.directiveId
      ? await deps.authoredDirectiveService.list(workspaceId, targetRef.agentId).then((directives) => directives.find((item) => item.id === targetRef.directiveId) ?? null).catch(() => null)
      : null;
    return { targetLabel: proposed.name, current, proposed };
  },
  async applyIfVersionMatches(workspaceId, rawTargetRef, payload, token) {
    const targetRef = directiveTargetRefSchema.parse(rawTargetRef);
    try {
      const directive = targetRef.directiveId
        ? (await deps.authoredDirectiveService.update(workspaceId, targetRef.agentId, targetRef.directiveId, directivePayload(payload), { expectedUpdatedAt: versionDate(token) })).directive
        : (await deps.authoredDirectiveService.create(workspaceId, targetRef.agentId, directivePayload(payload), { expectedAgentUpdatedAt: versionDate(token) })).directive;
      return { outcome: "applied" as const, appliedRef: { directiveId: directive.id } };
    } catch (error) {
      if (isStale(error)) return { outcome: "stale" as const };
      return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Directive apply failed" };
    }
  },
  async draft(workspaceId, rawTargetRef, intent) {
    const targetRef = directiveTargetRefSchema.parse(rawTargetRef);
    const draft = await deps.directiveAuthorService.draft(workspaceId, targetRef.agentId, {
      coachingText: intent,
      turn: { userMessage: intent, assistantAnswer: intent },
    });
    const directive = directivePayload(draft.directive);
    const summary = draft.rationale ?? directive.name;
    return { payload: { ...directive, rationale: summary }, targetLabel: directive.name, summary };
  },
});

/** Composition adapter: validates proposal values with the existing agent settings normalizer and applies through AgentService. */
export const createAgentSettingCopilotProposalAdapter = (deps: {
  readonly agentService: Pick<AgentService, "get" | "update">;
}): CopilotAgentSettingProposalAdapter => ({
  targetType: "agent_setting",
  async readVersionToken(workspaceId, rawTargetRef) {
    const targetRef = settingTargetRefSchema.parse(rawTargetRef);
    return versionToken((await deps.agentService.get(workspaceId, targetRef.agentId)).updatedAt);
  },
  async preview(workspaceId, rawTargetRef, rawPayload) {
    const targetRef = settingTargetRefSchema.parse(rawTargetRef);
    const payload = settingPayloadSchema.parse(rawPayload);
    const current = await deps.agentService.get(workspaceId, targetRef.agentId).catch(() => null);
    return { targetLabel: targetRef.settingKey, current: current ? settingValue(current, targetRef.settingKey) : null, proposed: payload.value };
  },
  async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token) {
    const targetRef = settingTargetRefSchema.parse(rawTargetRef);
    const payload = settingPayloadSchema.parse(rawPayload);
    try {
      await deps.agentService.update(workspaceId, targetRef.agentId, settingPatch(targetRef.settingKey, payload.value), { expectedUpdatedAt: versionDate(token) });
      return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId } };
    } catch (error) {
      if (isStale(error)) return { outcome: "stale" as const };
      return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Agent setting apply failed" };
    }
  },
  async validatePayload(workspaceId, rawTargetRef, rawPayload) {
    const targetRef = settingTargetRefSchema.parse(rawTargetRef);
    const payload = settingPayloadSchema.parse(rawPayload);
    const current = await deps.agentService.get(workspaceId, targetRef.agentId);
    const patch = settingPatch(targetRef.settingKey, payload.value);
    const merged = { ...current, ...patch, surfaceSettings: patch.surfaceSettings ? mergeAgentSurfaceSettings(current.surfaceSettings, patch.surfaceSettings) : current.surfaceSettings };
    const normalized = validateAgentInput(merged);
    if (!Object.hasOwn(normalized, targetRef.settingKey)) throw new Error("Unknown agent setting");
    return { targetRef, payload: { ...payload, value: settingValue(normalized, targetRef.settingKey) } };
  },
});

/**
 * Composition adapter for routines: drafts new ones through the coach, edits existing ones by
 * stable id, and moves them through their lifecycle. It is the only place that knows both the
 * copilot proposal contract and routine lifecycle rules — a draft is edited in place, a published
 * routine is revised into a draft first, and what is serving changes only through a publish.
 */
export const createRoutineCopilotProposalAdapter = (deps: {
  readonly agentService: Pick<AgentService, "get">;
  readonly routineDraftAssistService: Pick<RoutineDraftAssistService, "draft">;
  readonly routineDefinitionService: Pick<RoutineDefinitionService, "createDraft" | "deleteDraft" | "get" | "list" | "updateDraft" | "revise" | "publish" | "archive" | "restore" | "validate">;
}): CopilotRoutineProposalAdapter => {
  const routineFor = async (workspaceId: string, targetRef: { agentId: string; routineId: string | null }) =>
    deps.routineDefinitionService.get(workspaceId, targetRef.agentId, requiredRoutineId(targetRef));

  /**
   * The draft revision of a published routine's lineage, if one exists.
   *
   * Two writes turn on this: revising a published routine hands back an existing draft rather than
   * a fresh copy, and archiving deletes it. Both would otherwise destroy work the operator never
   * saw named.
   */
  const draftRevisionOf = async (workspaceId: string, agentId: string, routine: RoutineDefinition) =>
    (await deps.routineDefinitionService.list(workspaceId, agentId))
      .find((candidate) => candidate.lineageId === routine.lineageId && candidate.status === "draft" && candidate.id !== routine.id) ?? null;

  return {
    targetType: "routine",
    async readVersionToken(workspaceId, rawTargetRef) {
      const targetRef = routineTargetRefSchema.parse(rawTargetRef);
      // A new routine is guarded by the agent it will belong to; an existing one guards itself.
      if (!targetRef.routineId) return versionToken((await deps.agentService.get(workspaceId, targetRef.agentId)).updatedAt);
      return versionToken((await routineFor(workspaceId, targetRef)).updatedAt);
    },
    async preview(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = routineTargetRefSchema.parse(rawTargetRef);
      const kind = routinePayloadKind(rawPayload);
      if (kind === "create") {
        const proposed = routinePayload(rawPayload);
        return { targetLabel: proposed.name, current: null, proposed: projectRoutineForReview(proposed) };
      }
      const routine = await routineFor(workspaceId, targetRef).catch(() => null);
      if (kind === "lifecycle") {
        const payload = routineLifecyclePayloadSchema.parse(rawPayload);
        const discarded = routine && payload.action === "archive"
          ? await draftRevisionOf(workspaceId, targetRef.agentId, routine)
          : null;
        return {
          targetLabel: routine?.name ?? payload.name,
          current: routine ? { status: routine.status } : null,
          proposed: {
            status: routineStatusAfterAction[payload.action],
            ...(discarded ? { discardsDraftRevision: `${discarded.name} (draft, version ${discarded.version})` } : {}),
          },
        };
      }
      const payload = routineEditPayloadSchema.parse(rawPayload);
      if (!routine) return { targetLabel: payload.name, current: null, proposed: { editNoLongerApplies: "This routine no longer exists." } };
      try {
        return {
          targetLabel: routine.name,
          current: projectRoutineForReview(routine),
          proposed: projectRoutineForReview(applyRoutineFieldPatch(routine, payload.changes)),
        };
      } catch (error) {
        // The routine moved under the proposal. The version token already marks the card stale;
        // this says which part of the edit no longer has anything to address.
        return { targetLabel: routine.name, current: null, proposed: { editNoLongerApplies: error instanceof Error ? error.message : "This edit no longer applies." } };
      }
    },
    async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token) {
      const targetRef = routineTargetRefSchema.parse(rawTargetRef);
      const kind = routinePayloadKind(rawPayload);
      try {
        if (kind === "create") {
          const agent = await deps.agentService.get(workspaceId, targetRef.agentId);
          if (versionToken(agent.updatedAt) !== token) return { outcome: "stale" as const };
          const result = await deps.routineDefinitionService.createDraft(workspaceId, targetRef.agentId, routinePayload(rawPayload));
          // The card deep-links from appliedRef alone when the proposal detail was
          // never loaded, so the agent id must travel with the routine id.
          return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId, routineId: result.routine.id } };
        }
        const routine = await routineFor(workspaceId, targetRef);
        if (versionToken(routine.updatedAt) !== token) return { outcome: "stale" as const };
        if (kind === "lifecycle") {
          const payload = routineLifecyclePayloadSchema.parse(rawPayload);
          if (payload.action === "restore") {
            const validation = await deps.routineDefinitionService.validate(workspaceId, targetRef.agentId, { id: routine.id });
            if (!validation.ok) {
              return { outcome: "failed" as const, reason: `${routine.name} cannot be restored: ${diagnosticSummary(validation.diagnostics)}` };
            }
          }
          if (payload.action === "archive") {
            const discarded = await draftRevisionOf(workspaceId, targetRef.agentId, routine);
            const disclosed = discarded?.id === payload.discardsDraftRevisionId
              && discarded?.updatedAt.toISOString() === payload.discardsDraftRevisionUpdatedAt;
            if (!disclosed) {
              return {
                outcome: "failed" as const,
                reason: discarded
                  ? `The draft revision archiving ${routine.name} would delete (version ${discarded.version}) is not the one this card described. Draft the archive again so it says what would be lost.`
                  : `The draft revision this card offered to discard is already gone. Draft the archive again.`,
              };
            }
          }
          // Awaited inside the try on purpose: returning the promise would let its rejection past
          // the catch below, and a lifecycle failure would surface as an unhandled route error
          // instead of a failed proposal.
          return await applyRoutineLifecycle(deps, workspaceId, targetRef.agentId, routine, payload.action, payload.discardsDraftRevisionId
            ? { id: payload.discardsDraftRevisionId, updatedAt: new Date(payload.discardsDraftRevisionUpdatedAt!) }
            : null);
        }
        const payload = routineEditPayloadSchema.parse(rawPayload);
        if (!editableRoutineStatus(routine)) return { outcome: "failed" as const, reason: uneditableRoutineReason(routine) };
        // Editing a published routine edits a fresh revision of it. Nothing an operator applies
        // here changes what the agent is serving; that takes a separate publish proposal.
        if (routine.status === "draft") {
          await deps.routineDefinitionService.updateDraft(
            workspaceId,
            targetRef.agentId,
            routine.id,
            applyRoutineFieldPatch(routine, payload.changes),
            { expectedUpdatedAt: routine.updatedAt },
          );
          return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId, routineId: routine.id } };
        }
        // A draft revision holding work the operator never saw would be handed back by revise() and
        // patched from the published content, replacing what is in it. An untouched revision is a
        // verbatim copy of this routine, so reusing it changes nothing.
        const pending = await draftRevisionOf(workspaceId, targetRef.agentId, routine);
        if (pending && !sameAuthoredContent(pending, routine)) return { outcome: "stale" as const };
        const revision = await deps.routineDefinitionService.revise(workspaceId, targetRef.agentId, routine.id);
        // Belt and braces for the window between the check above and revise(): a draft created in
        // between comes back here, and anything already changed in it fails this comparison.
        if (!sameAuthoredContent(revision, routine)) return { outcome: "stale" as const };
        // A revision left behind by a failed edit is a verbatim copy of the published routine, the
        // same thing an author leaves behind by revising and walking away. The next edit reuses it
        // rather than tripping over it, so this deliberately does not try to take it back: a
        // clean-up racing whoever else may hold that draft is worse than an untouched copy.
        await deps.routineDefinitionService.updateDraft(
          workspaceId,
          targetRef.agentId,
          revision.id,
          applyRoutineFieldPatch(revision, payload.changes),
          { expectedUpdatedAt: revision.updatedAt },
        );
        return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId, routineId: revision.id } };
      } catch (error) {
        if (isStale(error)) return { outcome: "stale" as const };
        return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Routine change failed" };
      }
    },
    async draft(workspaceId, rawTargetRef, intent) {
      const targetRef = routineTargetRefSchema.parse(rawTargetRef);
      const result = await deps.routineDraftAssistService.draft(workspaceId, targetRef.agentId, { prose: intent });
      const diagnostics = result.validation.diagnostics;
      const summary = diagnostics.length === 0
        ? `Draft routine ${result.draft.name}.`
        : `Draft routine ${result.draft.name} has ${diagnostics.length} open validation diagnostic${diagnostics.length === 1 ? "" : "s"}.`;
      // The card summary is rebuilt from payload.rationale after a reload, so
      // the summary rides the stored payload the same way directive drafts do.
      return { payload: { ...result.draft, rationale: summary }, targetLabel: result.draft.name, summary, diagnostics };
    },
    async draftEdit(workspaceId, rawTargetRef, rawChanges, rationale) {
      const targetRef = routineTargetRefSchema.parse(rawTargetRef);
      const changes = routineFieldPatchSchema.parse(rawChanges);
      const routine = await routineFor(workspaceId, targetRef);
      if (!editableRoutineStatus(routine)) throw new Error(uneditableRoutineReason(routine));
      // A draft revision blocks this edit only when it holds work: revising a published routine
      // copies it verbatim, so a revision nobody has touched yet is the routine, and reusing it is
      // what applying this edit will do. Refusing on its mere existence would strand the routine
      // whenever a revision was created and abandoned.
      const pendingRevision = routine.status === "published" ? await draftRevisionOf(workspaceId, targetRef.agentId, routine) : null;
      if (pendingRevision && !sameAuthoredContent(pendingRevision, routine)) {
        throw new Error(`Routine ${routine.name} already has a draft revision (version ${pendingRevision.version}) with unpublished changes in it. Edit that draft, so this change lands on top of them rather than replacing them.`);
      }
      const patched = applyRoutineFieldPatch(routine, changes);
      const before = await deps.routineDefinitionService.validate(workspaceId, targetRef.agentId, { id: routine.id });
      const after = await deps.routineDefinitionService.validate(workspaceId, targetRef.agentId, { input: patched });
      // Only diagnostics this edit *introduces* block it. A routine that was already failing
      // validation must stay editable, or the one change that would fix it cannot be proposed.
      const carried = new Set(before.diagnostics.map(diagnosticIdentity));
      const introduced = after.diagnostics.filter((diagnostic) => !carried.has(diagnosticIdentity(diagnostic)));
      if (introduced.length > 0) throw new Error(`This edit would break ${routine.name}: ${diagnosticSummary(introduced)}`);
      const summary = withRationale(`Edit routine ${routine.name}: ${describeRoutineFieldPatch(changes)}.`, rationale);
      return {
        payload: { kind: "edit", name: routine.name, changes, rationale: summary },
        targetLabel: routine.name,
        summary,
        diagnostics: after.diagnostics,
      };
    },
    async draftLifecycle(workspaceId, rawTargetRef, action, rationale) {
      const targetRef = routineTargetRefSchema.parse(rawTargetRef);
      const routine = await routineFor(workspaceId, targetRef);
      const required = routineStatusForAction[action];
      if (routine.status !== required) {
        const pending = action === "publish" && routine.status === "published"
          ? await draftRevisionOf(workspaceId, targetRef.agentId, routine)
          : null;
        throw new Error(pending
          ? `Routine ${routine.name} is already published. Its draft revision (version ${pending.version}) is what there is to publish.`
          : `Routine ${routine.name} is ${routine.status}; only a routine that is ${required} can be ${action}ed.`);
      }
      // Publish and restore both put a routine in front of customers, so both run the validation
      // publish runs. Restore skips it in the service — a routine can be archived while valid and
      // lose a skill or an action capability before anyone restores it — so the check lives here.
      const diagnostics = goesLive(action)
        ? (await deps.routineDefinitionService.validate(workspaceId, targetRef.agentId, { id: routine.id })).diagnostics
        : [];
      if (diagnostics.length > 0) {
        throw new Error(`Routine ${routine.name} cannot be ${action}ed yet: ${diagnosticSummary(diagnostics)}`);
      }
      // Archiving deletes the lineage's draft revision. The operator has to be told that before
      // they apply, because nothing restores it afterwards.
      const discarded = action === "archive" ? await draftRevisionOf(workspaceId, targetRef.agentId, routine) : null;
      const summary = withRationale(
        `${routineActionVerb[action]} routine ${routine.name}.${discarded ? ` This discards its draft revision (version ${discarded.version}).` : ""}`,
        rationale,
      );
      return {
        payload: {
          kind: "lifecycle",
          action,
          name: routine.name,
          rationale: summary,
          ...(discarded ? { discardsDraftRevisionId: discarded.id, discardsDraftRevisionUpdatedAt: discarded.updatedAt.toISOString() } : {}),
        },
        targetLabel: routine.name,
        summary,
        diagnostics,
      };
    },
  };
};

/**
 * Identifies a diagnostic across an edit. Locations address stable ids, except routine-level ones,
 * which carry the routine's name — so renaming a routine would otherwise look like it introduced
 * every routine-level diagnostic the routine already had, and block the rename.
 */
const diagnosticIdentity = (diagnostic: RoutineValidationDiagnostic): string =>
  `${diagnostic.code}@${diagnostic.location.startsWith("routine:") ? "routine:" : diagnostic.location}`;

// Compares what an author can change, ignoring identity and timestamps: two routines match when
// applying the same edit to either produces the same result.
const sameAuthoredContent = (left: RoutineDefinition, right: RoutineDefinition): boolean =>
  JSON.stringify(projectRoutineForReview(left)) === JSON.stringify(projectRoutineForReview(right));

const applyRoutineLifecycle = async (
  deps: { readonly routineDefinitionService: Pick<RoutineDefinitionService, "publish" | "archive" | "restore" | "list"> },
  workspaceId: string,
  agentId: string,
  routine: RoutineDefinition,
  action: CopilotRoutineLifecycleAction,
  discardsDraftRevision: { id: string; updatedAt: Date } | null = null,
): Promise<{ outcome: "applied"; appliedRef: unknown } | { outcome: "failed"; reason: string }> => {
  try {
    if (action === "publish") {
      // The token was checked against this row a moment ago; stating it in the write is what stops a
      // save landing in between from going live unreviewed.
      const result = await deps.routineDefinitionService.publish(workspaceId, agentId, routine.id, { expectedUpdatedAt: routine.updatedAt });
      if ("rejected" in result) {
        return { outcome: "failed", reason: `${routine.name} could not be published: ${diagnosticSummary(result.validation.diagnostics)}` };
      }
      return { outcome: "applied", appliedRef: { agentId, routineId: result.routine.id } };
    }
    const moved = action === "archive"
      // Stating the disclosed draft here puts the precondition inside the archive transaction, where
      // a revision created a moment ago cannot slip past it and be deleted unannounced.
      ? await deps.routineDefinitionService.archive(workspaceId, agentId, routine.id, { expectedDraftRevision: discardsDraftRevision })
      : await deps.routineDefinitionService.restore(workspaceId, agentId, routine.id);
    return { outcome: "applied", appliedRef: { agentId, routineId: moved.id } };
  } catch (error) {
    // A conflict is the write refusing before it committed — the version moved, or the draft this
    // archive described did. Nothing happened, so say so rather than looking at the routine: by
    // then another writer may have made the same transition, and this proposal would take credit
    // for content its own write never put live.
    if (isStale(error)) throw error;
    // Everything else may have committed the status change and then failed in the tail that
    // follows it — trigger embeddings, a lifecycle audit event, a re-validation of the saved row.
    // Marking the card failed for a routine that is already live strands it: re-applying fails on
    // the status precondition. Ask the routine what happened instead of guessing.
    const settled = await landedLifecycleChange(deps, workspaceId, agentId, routine, action);
    if (!settled) throw error;
    return settled;
  }
};

const landedLifecycleChange = async (
  deps: { readonly routineDefinitionService: Pick<RoutineDefinitionService, "list"> },
  workspaceId: string,
  agentId: string,
  routine: RoutineDefinition,
  action: CopilotRoutineLifecycleAction,
): Promise<{ outcome: "applied"; appliedRef: unknown } | null> => {
  // Every lifecycle write moves this row in place — publishing flips the draft row itself — so the
  // question is only whether this row reached the status the action was for. Accepting any
  // published member of the lineage would read the *previous* live version, which is still
  // published until the flip commits, as this proposal having landed.
  const landed = (await deps.routineDefinitionService.list(workspaceId, agentId).catch(() => []))
    .find((candidate) => candidate.id === routine.id && candidate.status === routineStatusAfterAction[action]);
  return landed ? { outcome: "applied", appliedRef: { agentId, routineId: landed.id } } : null;
};

// Maps a stored proposal payload onto the management input. The draft keeps
// presentation extras (e.g. the coach's rationale) that the .strict()
// directive input schema rejects, so unknown keys are stripped here.
const directivePayload = (value: unknown): AuthoredDirectiveInput => {
  const draft = z.object({
    name: z.string(),
    condition: z.unknown(),
    action: z.string(),
    tags: z.array(z.string()).optional(),
    priority: z.number().nullable().optional(),
    criticality: z.unknown().optional(),
    requiredCapabilities: z.array(z.string()).optional(),
    dependsOn: z.array(z.string()).optional(),
    excludes: z.array(z.string()).optional(),
    description: z.string().optional(),
    binding: z.unknown().optional(),
    lifecycle: z.unknown().optional(),
    metadata: z.record(z.unknown()).optional(),
  }).parse(value);
  return draft as AuthoredDirectiveInput;
};

// Strips the draft-only rationale before the .strict() authoring schema, the
// same way directivePayload drops the coach's presentation extras.
const routinePayload = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { rationale: _rationale, ...rest } = value as Record<string, unknown>;
    return routineDefinitionDraftInputSchema.parse(rest);
  }
  return routineDefinitionDraftInputSchema.parse(value);
};

const settingPatch = (settingKey: string, value: unknown): AgentInput => ({ [settingKey]: value }) as AgentInput;
const settingValue = (settings: object, settingKey: string): unknown => Object.hasOwn(settings, settingKey) ? (settings as Record<string, unknown>)[settingKey] : undefined;
const versionToken = (updatedAt: Date): string => updatedAt.toISOString();
const versionDate = (token: string): Date => new Date(token);
const isStale = (error: unknown): boolean => error instanceof AppError && (error.code === "conflict" || error.code === "not_found");
