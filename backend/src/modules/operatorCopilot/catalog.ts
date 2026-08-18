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

const resolvedDescription = (
  description: CopilotEntityDescription<unknown> | null,
  input: unknown,
): { entity: CopilotEntityReference | null; input: unknown; candidates: ReadonlyArray<CopilotEntityReference> | null } => {
  if (!description) return { entity: null, input, candidates: null };
  if (!isEntityResolution(description)) return { entity: description, input, candidates: null };
  if (description.kind === "ambiguous") return { entity: null, input, candidates: description.candidates };
  if (description.kind === "not_found") return { entity: null, input, candidates: [] };
  return { entity: description.entity, input: description.input, candidates: null };
};

const deniedResolution = (workspaceKey: string, dashboardSubject: CopilotEntityReference) => ({
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
          return deniedResolution(workspaceKey, descriptor.dashboardSubject);
        }

        const description = descriptor.describeEntity
          ? await descriptor.describeEntity(input, context)
          : null;
        const resolution = resolvedDescription(description, input);
        if (resolution.candidates) {
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
