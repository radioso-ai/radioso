import type { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { AppError } from "../../../shared/domain/errors.js";
import {
  VoiceRuntimeConnectionError,
  type VoiceRuntimeConnectionActor,
  type VoiceRuntimeConnectionFailure,
} from "../../../modules/voiceChannel/public.js";
import { requireApiAccessCsrf } from "../middleware/requireApiAccessCsrf.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";

type AgentVoiceConnectionRouteDependencies = Parameters<typeof requireWorkspaceSession>[0]
  & Parameters<typeof requireWorkspacePermission>[0]
  & Pick<AppDependencies, "voiceRuntimeConnections">;

const agentParamsSchema = z.object({ agentId: z.string().uuid() });

/**
 * Each way a Connect can fail, as the answer the Voice card reads. The code is the contract; the
 * card writes its own words for each.
 */
const FAILURE_ANSWERS: Readonly<Record<VoiceRuntimeConnectionFailure, { status: number; code: string; message: string }>> = {
  agent_not_found: { status: 404, code: "not_found", message: "Agent not found" },
  connection_busy: {
    status: 409,
    code: "voice_connection_busy",
    message: "Another Connect or Disconnect of this agent's voice runtime is running; try again when it finishes",
  },
  connection_unavailable: {
    status: 503,
    code: "voice_connection_unavailable",
    message: "This deployment has no public API address a voice vendor can reach; set PUBLIC_API_BASE_URL",
  },
  vendor_key_missing: { status: 409, code: "voice_vendor_key_missing", message: "Store the voice vendor's API key under Settings → Providers first" },
  vendor_key_unreadable: {
    status: 409,
    code: "voice_vendor_key_unreadable",
    message: "The stored voice vendor key cannot be decrypted; enter it again under Settings → Providers",
  },
  vendor_key_rejected: { status: 422, code: "voice_vendor_key_rejected", message: "The voice vendor does not accept the stored API key" },
  vendor_key_lacks_agents_permission: {
    status: 422,
    code: "voice_vendor_key_lacks_agents_permission",
    message: "The stored API key may not manage the voice vendor's agents",
  },
  vendor_unreachable: { status: 503, code: "voice_vendor_unreachable", message: "The voice vendor did not answer; try again" },
  vendor_failed: { status: 502, code: "voice_vendor_failed", message: "The voice vendor would not set up the agent" },
};

const answerFor = (error: unknown): unknown => {
  if (!(error instanceof VoiceRuntimeConnectionError)) return error;
  const answer = FAILURE_ANSWERS[error.reason];
  return new AppError(answer.status, answer.code, answer.message);
};

const actorOf = (locals: { accountId?: string; userId?: string }): VoiceRuntimeConnectionActor => ({
  accountId: locals.accountId ?? null,
  userId: locals.userId ?? null,
});

/**
 * The agent's managed voice runtime, for the Voice card: its status, Connect (create or repair the
 * vendor agent Radioso maintains, and bind it) and Disconnect. Dashboard sessions only, with the
 * agent manage permission: Connect issues an access grant and Disconnect revokes one.
 */
export const registerAgentVoiceConnectionRoutes = (router: Router, dependencies: AgentVoiceConnectionRouteDependencies): void => {
  const workspaceSession = requireWorkspaceSession(dependencies);
  const agentManage = requireWorkspacePermission(dependencies, "workspace.agents.manage");
  const path = "/:agentId/voice/connection";

  router.get(path, workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { agentId } = agentParamsSchema.parse(req.params);
      res.status(200).json(await dependencies.voiceRuntimeConnections.status({ workspaceId, agentId }));
    } catch (error) {
      next(answerFor(error));
    }
  });

  router.post(path, workspaceSession, requireApiAccessCsrf, agentManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { agentId } = agentParamsSchema.parse(req.params);
      const actor = actorOf(res.locals as { accountId?: string; userId?: string });
      res.status(200).json(await dependencies.voiceRuntimeConnections.connect({ workspaceId, agentId, actor }));
    } catch (error) {
      next(answerFor(error));
    }
  });

  router.delete(path, workspaceSession, requireApiAccessCsrf, agentManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { agentId } = agentParamsSchema.parse(req.params);
      const actor = actorOf(res.locals as { accountId?: string; userId?: string });
      res.status(200).json(await dependencies.voiceRuntimeConnections.disconnect({ workspaceId, agentId, actor }));
    } catch (error) {
      next(answerFor(error));
    }
  });
};
