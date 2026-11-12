import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { AppError, notFound } from "../../../shared/domain/errors.js";
import { requireApiAccessCsrf } from "../middleware/requireApiAccessCsrf.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";
import { presentStartedVoiceSession } from "../presenters/voiceSessionPresenter.js";
import { publicVoiceSessionStartSchema } from "./publicChatRouteSchemas.js";

type TestChatVoiceSessionRouteDependencies = WorkspaceSessionDependencies
  & Parameters<typeof requireWorkspacePermission>[0]
  & Pick<AppDependencies, "testExecutionService" | "voiceSessionStarts">;

const executionParams = z.object({ agentId: z.string().uuid(), executionId: z.string().uuid() });

/** The same body as the website embed's start: the caller's language tag, when the page names one. */
const testChatVoiceSessionStartSchema = publicVoiceSessionStartSchema;

/**
 * `POST /:agentId/test-executions/:executionId/voice-sessions`: Test Chat's Talk. It starts a voice
 * session on the agent's vendor agent for one of the operator's private tests, so the call's turns
 * run on the revision under test and are recorded in that test, never as a conversation. Dashboard
 * sessions only (`sessionOnly` in `apiPrincipalRoutePolicy.ts`), with the agent manage permission and
 * the CSRF header: the answer carries the vendor's signed URL, which opens sessions on the
 * workspace's vendor account. The test says what the call opens with; the start passes the same
 * voice gate as the website embed's.
 */
export const createTestChatVoiceSessionRoutes = (dependencies: TestChatVoiceSessionRouteDependencies): Router => {
  const router = Router();
  router.post(
    "/:agentId/test-executions/:executionId/voice-sessions",
    requireWorkspaceSession(dependencies),
    requireApiAccessCsrf,
    requireWorkspacePermission(dependencies, "workspace.agents.manage"),
    validateBody(testChatVoiceSessionStartSchema),
    async (req, res, next) => {
      try {
        const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string | null };
        const { agentId, executionId } = executionParams.parse(req.params);
        const { locale } = req.body as z.infer<typeof testChatVoiceSessionStartSchema>;
        const { greeting } = await dependencies.testExecutionService.spokenSessionOpening({ workspaceId, agentId, executionId });
        const result = await dependencies.voiceSessionStarts.start({
          workspaceId,
          agentId,
          test: { testExecutionId: executionId, accountId: accountId ?? null, greeting },
          ...(locale ? { locale } : {}),
        });
        if (result.kind === "unavailable") {
          next(notFound("Voice calls are not available for this agent."));
          return;
        }
        if (result.kind === "failed") {
          next(new AppError(503, "voice_unavailable", "The voice session could not be started. Try again later."));
          return;
        }
        // The signed URL opens sessions on the workspace's vendor account until it expires: no cache may keep it.
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json(presentStartedVoiceSession(result));
      } catch (error) {
        next(error);
      }
    },
  );
  return router;
};
