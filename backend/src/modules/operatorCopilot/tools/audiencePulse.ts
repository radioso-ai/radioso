import { z } from "zod";

import type { CopilotToolDescriptor } from "../contracts.js";
import { boundPayload } from "../payloadCompaction.js";
import { asRecord } from "./shared.js";

const unknownRecord = z.record(z.unknown());

export interface CopilotAudiencePulsePort {
  read(input: { accountId: string; userId: string; workspaceId: string }): Promise<object>;
  refreshStatus(input: { accountId: string; userId: string; workspaceId: string }): Promise<{ pending: boolean }>;
}

export interface AudiencePulseCopilotToolDependencies {
  readonly audiencePulseService: CopilotAudiencePulsePort;
}

export const createAudiencePulseCopilotTools = (deps: AudiencePulseCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "audience_topics", shape: "read", verificationCost: () => 0, uiLabel: "Reading audience topics", contributingModule: "audiencePulse", dashboardSubject: { type: "audience_topics" }, requiredPermissions: ["workspace.quality.read"],
    description: "Read the latest stored Audience Pulse topic census and whether its preparation is still running. This never starts a new analysis.",
    inputSchema: z.object({}), outputSchema: z.object({ result: unknownRecord, preparation: z.object({ pending: z.boolean() }) }),
    createTool: (context) => ({ name: "audience_topics", description: "Read the latest stored Audience Pulse topic census and whether its preparation is still running. This never starts a new analysis.", inputSchema: z.object({}), outputSchema: z.object({ result: unknownRecord, preparation: z.object({ pending: z.boolean() }) }), invoke: async () => {
      const input = { accountId: context.accountId, userId: context.operatorUserId, workspaceId: context.workspaceId };
      const [result, preparation] = await Promise.all([
        deps.audiencePulseService.read(input),
        deps.audiencePulseService.refreshStatus(input),
      ]);

      return boundPayload({ result: asRecord(result), preparation });
    } }),
  },
];
