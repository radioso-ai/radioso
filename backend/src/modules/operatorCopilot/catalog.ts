import { z } from "zod";

import type { AccountPermission } from "../account/public.js";
import type { CopilotToolDescriptor } from "./contracts.js";
import type { CopilotEntityDescription, CopilotEntityReference, CopilotToolInvocationContext } from "./contracts.js";
import { buildCopilotDashboardLink } from "./dashboardLinks.js";

export const filterCopilotToolCatalog = (
  descriptors: ReadonlyArray<CopilotToolDescriptor>,
  permissions: ReadonlySet<AccountPermission>,
): ReadonlyArray<CopilotToolDescriptor> => descriptors.filter((descriptor) => permissions.has(descriptor.requiredPermission));

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
  createTool: (context: CopilotToolInvocationContext) => {
    const tool = descriptor.createTool(context);
    return {
      ...tool,
      outputSchema: linkedOutputSchema,
      invoke: async (input, agentContext) => {
        const workspaceKey = await deps.resolveWorkspaceKey(context.workspaceId);
        if (context.permissions && !context.permissions.has(descriptor.requiredPermission)) {
          return unresolved(workspaceKey, descriptor.dashboardSubject);
        }

        const description = descriptor.describeEntity
          ? await descriptor.describeEntity(input, context)
          : null;
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

        const output = await tool.invoke(resolution.input, agentContext);
        if (!isRecord(output)) {
          throw new Error(`Copilot tool "${descriptor.name}" returned a non-object result`);
        }
        return {
          ...output,
          dashboardUrl: buildCopilotDashboardLink(
            workspaceKey,
            resolution.entity ?? descriptor.dashboardSubject,
          ),
        };
      },
    };
  },
}));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
