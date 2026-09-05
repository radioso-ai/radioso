import { z } from "zod";

import type { AccountPermission } from "../account/public.js";
import type { CopilotToolDescriptor } from "./contracts.js";
import type { CopilotEntityDescription, CopilotEntityReference, CopilotToolInvocationContext } from "./contracts.js";
import { CopilotToolAuthorizationError, hasCurrentCopilotPermissions } from "./authorization.js";
import { buildCopilotDashboardLink } from "./dashboardLinks.js";

export const hasAllCopilotToolPermissions = (
  requiredPermissions: CopilotToolDescriptor["requiredPermissions"],
  permissions: ReadonlySet<string> | undefined,
): boolean => requiredPermissions.every((permission) => permissions?.has(permission) === true);

export const filterCopilotToolCatalog = (
  descriptors: ReadonlyArray<CopilotToolDescriptor>,
  permissions: ReadonlySet<AccountPermission>,
): ReadonlyArray<CopilotToolDescriptor> => descriptors.filter((descriptor) =>
  hasAllCopilotToolPermissions(descriptor.requiredPermissions, permissions));

/**
 * A descriptor can be selected from the turn-start catalog, then wait behind a
 * model step while the operator's role changes. Re-read entitlement immediately
 * before each descriptor-owned read/effect. The turn-start snapshot is used
 * only for initial catalog discovery and cannot authorize descriptor hooks.
 */
export const hasCurrentCopilotToolPermissions = async (
  descriptor: CopilotToolDescriptor,
  context: CopilotToolInvocationContext,
): Promise<boolean> => hasCurrentCopilotPermissions(context, descriptor.requiredPermissions);

const linkedOutputSchema = z.object({ dashboardUrl: z.string().startsWith("/") }).passthrough();

const isEntityResolution = (
  description: CopilotEntityDescription<unknown>,
): description is Exclude<CopilotEntityDescription<unknown>, CopilotEntityReference> =>
  "kind" in description;

/**
 * Discriminated on status rather than on whether a candidate list is present: "no match" and
 * "several matches" both carry zero-or-more candidates, so any attempt to tell them apart from the
 * list itself collapses them — an empty array is truthy, and a not_found then reads as an ambiguity
 * with nothing to choose between.
 */
type CopilotEntityResolution =
  | { readonly status: "resolved"; readonly entity: CopilotEntityReference | null; readonly input: unknown }
  | { readonly status: "ambiguous"; readonly candidates: ReadonlyArray<CopilotEntityReference> }
  | { readonly status: "not_found" };

const resolvedDescription = (
  description: CopilotEntityDescription<unknown> | null,
  input: unknown,
): CopilotEntityResolution => {
  if (!description) return { status: "resolved", entity: null, input };
  if (!isEntityResolution(description)) return { status: "resolved", entity: description, input };
  if (description.kind === "ambiguous") return { status: "ambiguous", candidates: description.candidates };
  if (description.kind === "not_found") return { status: "not_found" };
  return { status: "resolved", entity: description.entity, input: description.input };
};

/**
 * The resolved entity may *refine* the declared handoff subject, never *redirect* it.
 *
 * describeEntity answers "what is this call operating on", which is not the same question as
 * "where should the operator go afterwards". They coincide for a reader like agent_configuration,
 * whose output is the agent it resolved. They diverge whenever an entity is only a parameter:
 * propose_directive resolves the target agent but produces a proposal, and eval/quality resolve an
 * agent to filter by while producing eval cases and quality turns. Letting the resolved entity win
 * unconditionally sent the operator to the agent page after drafting a proposal.
 *
 * Matching on type keeps the refinement (a resolved id makes the link specific) without the
 * redirect, and needs no extra declaration beyond the dashboardSubject a descriptor already has.
 */
const handoffSubject = (
  declared: CopilotEntityReference,
  resolved: CopilotEntityReference | null,
): CopilotEntityReference => (resolved && resolved.type === declared.type ? resolved : declared);

/** Shared by permission denial and genuine absence, so the two stay indistinguishable to callers. */
const unresolved = (workspaceKey: string, dashboardSubject: CopilotEntityReference) => ({
  dashboardUrl: buildCopilotDashboardLink(workspaceKey, dashboardSubject),
  resolution: { status: "not_found" as const, candidates: [] },
});

/**
 * Makes module-owned entity descriptions usable from transports with no page
 * context. The descriptor resolves names; this shared boundary only enforces
 * its declared permission and presents normal ambiguity results with links.
 */
export const enrichCopilotToolCatalog = (
  descriptors: ReadonlyArray<CopilotToolDescriptor>,
  deps: { readonly resolveWorkspaceKey: (workspaceId: string) => Promise<string> },
): ReadonlyArray<CopilotToolDescriptor> => descriptors.map((descriptor) => ({
  ...descriptor,
  outputSchema: linkedOutputSchema,
  createTool: (context: CopilotToolInvocationContext) => {
    const tool = descriptor.createTool(context);
    return {
      ...tool,
      outputSchema: linkedOutputSchema,
      invoke: async (input, agentContext) => {
        const workspaceKey = await deps.resolveWorkspaceKey(context.workspaceId);
        // Current authorization is mandatory even if a transport bypasses turn-start catalog
        // filtering, so descriptor hooks never rely on a stale permission snapshot.
        if (!(await hasCurrentCopilotToolPermissions(descriptor, context))) {
          return unresolved(workspaceKey, descriptor.dashboardSubject);
        }

        const description = descriptor.describeEntity
          ? await descriptor.describeEntity(input, context)
          : null;
        // A resolver can read protected names and candidates. Do not let a role change while it
        // runs turn that result into an ambiguity or handoff visible to the model or dashboard.
        if (descriptor.describeEntity && !(await hasCurrentCopilotToolPermissions(descriptor, context))) {
          return unresolved(workspaceKey, descriptor.dashboardSubject);
        }
        const resolution = resolvedDescription(description, input);
        // Deliberately the same shape a permission denial returns: an operator who may not read an
        // entity must not be able to tell it apart from one that does not exist.
        if (resolution.status === "not_found") {
          return unresolved(workspaceKey, descriptor.dashboardSubject);
        }
        if (resolution.status === "ambiguous") {
          return {
            dashboardUrl: buildCopilotDashboardLink(workspaceKey, descriptor.dashboardSubject),
            resolution: {
              status: "ambiguous" as const,
              candidates: resolution.candidates.map((candidate) => ({
                ...candidate,
                dashboardUrl: buildCopilotDashboardLink(workspaceKey, candidate),
              })),
            },
          };
        }

        // Resolution itself is protected and a role can change while it runs.
        // Check again before the effect/read represented by the tool invocation.
        if (!(await hasCurrentCopilotToolPermissions(descriptor, context))) {
          return unresolved(workspaceKey, descriptor.dashboardSubject);
        }
        let output: unknown;
        try {
          output = await tool.invoke(resolution.input, agentContext);
        } catch (error) {
          // Proposal tools can detect revocation at their own preflight and persistence boundaries.
          // Present that denial exactly like absence rather than surfacing a tool error or a draft.
          if (error instanceof CopilotToolAuthorizationError) return unresolved(workspaceKey, descriptor.dashboardSubject);
          throw error;
        }
        // A descriptor-owned read can finish after its pre-invocation authorization check. Never
        // project its result into the model context unless the operator is still entitled now.
        if (!(await hasCurrentCopilotToolPermissions(descriptor, context))) {
          return unresolved(workspaceKey, descriptor.dashboardSubject);
        }
        if (!isRecord(output)) {
          throw new Error(`Copilot tool "${descriptor.name}" returned a non-object result`);
        }
        const outputEntity = descriptor.describeOutputEntity?.(output) ?? null;
        const enrichedOutput = {
          ...output,
          dashboardUrl: buildCopilotDashboardLink(
            workspaceKey,
            handoffSubject(descriptor.dashboardSubject, outputEntity ?? resolution.entity),
          ),
        };
        return descriptor.finalizeEnrichedOutput?.(enrichedOutput) ?? enrichedOutput;
      },
    };
  },
}));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
