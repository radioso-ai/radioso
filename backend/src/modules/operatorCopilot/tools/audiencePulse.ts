import { z } from "zod";

import type { CopilotToolDescriptor } from "../contracts.js";
import { boundPayload } from "../payloadCompaction.js";
import { asRecord } from "./shared.js";

const unknownRecord = z.record(z.unknown());

export interface CopilotAudiencePulsePort {
  read(input: { accountId: string; userId: string; workspaceId: string }): Promise<object>;
}

export interface AudiencePulseCopilotToolDependencies {
  readonly audiencePulseService: CopilotAudiencePulsePort;
}

export const createAudiencePulseCopilotTools = (deps: AudiencePulseCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "audience_topics", shape: "read", uiLabel: "Reading audience topics", contributingModule: "audiencePulse", dashboardSubject: { type: "audience_topics" }, requiredPermission: "workspace.quality.read",
    description: "Read the latest stored Audience Pulse topic census. This never starts a new analysis.",
    inputSchema: z.object({}), outputSchema: z.object({ result: unknownRecord }),
    createTool: (context) => ({ name: "audience_topics", description: "Read the latest stored Audience Pulse topic census. This never starts a new analysis.", inputSchema: z.object({}), outputSchema: z.object({ result: unknownRecord }), invoke: async () => boundPayload({ result: asRecord(await deps.audiencePulseService.read({ accountId: context.accountId, userId: context.operatorUserId, workspaceId: context.workspaceId })) }) }),
  },
];
