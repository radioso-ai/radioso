import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import type { DataSubjectConversation, DataSubjectIdentityCandidate } from "../../../modules/privacy/public.js";
import { DATA_SUBJECT_IDENTITY_KINDS } from "../../../shared/domain/dataSubjectAccess.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";
import { erasureActor } from "./historyRoutes.js";

type PrivacyRouteDependencies = WorkspaceSessionDependencies & Pick<AppDependencies, "dataSubjectAccess">;

/** An email address can run to 320 characters; nothing a lookup matches is longer. */
export const dataSubjectLookupRequestSchema = z.object({
  query: z.string().trim().min(1).max(320).describe(
    "A verified customer id, an email address, or a Slack member id. Matched exactly: an address without regard to case, the others as stored.",
  ),
}).strict();

export const dataSubjectIdentitySchema = z.object({
  kind: z.enum(DATA_SUBJECT_IDENTITY_KINDS),
  key: z.string().min(1).max(512).describe("The identity's key, as the lookup returned it."),
}).strict();

export const dataSubjectIdentitiesRequestSchema = z.object({
  identities: z.array(dataSubjectIdentitySchema).min(1).max(50).describe("The identities the operator confirmed belong to the data subject."),
}).strict();

const presentCandidate = (candidate: DataSubjectIdentityCandidate) => ({
  identity: candidate.identity,
  channel: candidate.channel,
  label: candidate.label,
  conversationCount: candidate.conversationCount,
  firstSeenAt: candidate.firstSeenAt?.toISOString() ?? null,
  lastSeenAt: candidate.lastSeenAt?.toISOString() ?? null,
});

const presentConversation = (conversation: DataSubjectConversation) => ({
  id: conversation.id,
  channel: conversation.channel,
  title: conversation.title,
  startedAt: conversation.startedAt.toISOString(),
  lastActivityAt: conversation.lastActivityAt.toISOString(),
  messageCount: conversation.messageCount,
});

const handle = (work: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    work(req, res).catch(next);
  };

const workspaceOf = (res: Response): string => (res.locals as { workspaceId: string }).workspaceId;

/**
 * A data subject request: find the person, review their conversations, export what is held about
 * them, and erase it. Every step is a POST, so the identifiers it carries stay out of URLs and
 * access logs, and every step needs `workspace.history.delete`, the permission erasure needs.
 */
export const createPrivacyRoutes = (dependencies: PrivacyRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const historyDelete = requireWorkspacePermission(dependencies, "workspace.history.delete");
  const access = dependencies.dataSubjectAccess;

  router.post("/data-subjects/lookup", workspaceSession, historyDelete, validateBody(dataSubjectLookupRequestSchema), handle(async (req, res) => {
    const { query } = req.body as z.infer<typeof dataSubjectLookupRequestSchema>;
    const candidates = await access.lookup({ workspaceId: workspaceOf(res), query, actor: erasureActor(res) });
    res.status(200).json({ identities: candidates.map(presentCandidate) });
  }));

  router.post("/data-subjects/conversations", workspaceSession, historyDelete, validateBody(dataSubjectIdentitiesRequestSchema), handle(async (req, res) => {
    const { identities } = req.body as z.infer<typeof dataSubjectIdentitiesRequestSchema>;
    const conversations = await access.listConversations({ workspaceId: workspaceOf(res), identities });
    res.status(200).json({ conversations: conversations.map(presentConversation) });
  }));

  router.post("/data-subjects/export", workspaceSession, historyDelete, validateBody(dataSubjectIdentitiesRequestSchema), handle(async (req, res) => {
    const { identities } = req.body as z.infer<typeof dataSubjectIdentitiesRequestSchema>;
    const document = await access.export({ workspaceId: workspaceOf(res), identities, actor: erasureActor(res) });
    res.set("Cache-Control", "no-store").status(200).json(document);
  }));

  router.post("/data-subjects/erase", workspaceSession, historyDelete, validateBody(dataSubjectIdentitiesRequestSchema), handle(async (req, res) => {
    const { identities } = req.body as z.infer<typeof dataSubjectIdentitiesRequestSchema>;
    res.status(200).json(await access.erase({ workspaceId: workspaceOf(res), identities, actor: erasureActor(res) }));
  }));

  return router;
};
