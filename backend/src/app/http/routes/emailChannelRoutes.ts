import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { MAILBOX_SETTING_BOUNDS } from "../../../modules/emailChannel/public.js";
import { AppError, badRequest, notFound, unauthorized } from "../../../shared/domain/errors.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { validateBody, validateQuery } from "../middleware/validate.js";

type EmailChannelRouteDependencies = WorkspaceSessionDependencies & Pick<AppDependencies, "emailChannel">;
type EmailChannel = NonNullable<AppDependencies["emailChannel"]>;

const engagementModeSchema = z.enum(["operator_only", "draft", "auto"]);
const boundedSetting = (setting: keyof typeof MAILBOX_SETTING_BOUNDS) =>
  z.number().int().min(MAILBOX_SETTING_BOUNDS[setting][0]).max(MAILBOX_SETTING_BOUNDS[setting][1]);

// Addresses and domains are strings here: the services own their syntax and answer
// `invalid_address` / `invalid_domain`, which a format check at this layer would pre-empt.
const mailboxSettingsShape = {
  displayName: z.string().min(1),
  agentId: z.string().uuid().nullable().optional(),
  engagementMode: engagementModeSchema.optional(),
  threadSendBudget: boundedSetting("threadSendBudget").optional(),
  hourlyGenerationBudget: boundedSetting("hourlyGenerationBudget").optional(),
  silenceThresholdHours: boundedSetting("silenceThresholdHours").optional(),
  /** Required as `true` to put a mailbox into `auto`; the service answers `auto_opt_in_required` without it. */
  autoOptIn: z.boolean().optional(),
};

export const createEmailMailboxRequestSchema = z.object({
  address: z.string().min(1).max(320),
  ...mailboxSettingsShape,
}).strict();

export const updateEmailMailboxRequestSchema = z.object({
  ...mailboxSettingsShape,
  displayName: mailboxSettingsShape.displayName.optional(),
  enabled: z.boolean().optional(),
  expectedPolicyVersion: z.number().int().min(1).optional(),
}).strict();

export const startEmailMailboxSetupCheckRequestSchema = z.object({
  step: z.enum(["base", "plus_address"]),
}).strict();

export const addEmailSendingDomainRequestSchema = z.object({
  domain: z.string().min(1).max(253),
}).strict();

export const enableEmailDirectReceivingRequestSchema = z.object({
  confirmation: z.string().min(1).max(253),
}).strict();

export const listEmailMailboxEventsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  disposition: z.enum(["ingest_only", "run_review_turn", "drop"]).optional(),
  state: z.enum(["pending", "fetched", "ingested", "done", "failed"]).optional(),
}).strict();

export const listEmailChannelEventsQuerySchema = listEmailMailboxEventsQuerySchema.extend({
  mailboxId: z.string().uuid().optional(),
}).strict();

const uuidSchema = z.string().uuid();

const uuidParam = (req: Request, name: string): string => {
  const parsed = uuidSchema.safeParse(req.params[name]);
  if (!parsed.success) throw badRequest(`Invalid ${name}`);
  return parsed.data;
};

/** Session-only routes, so a signed-in teammate is always present; the check keeps a misread policy from writing an unattributed change. */
const actorOf = (res: Response): { userId: string; accountId: string } => {
  const { userId, accountId } = res.locals as { userId?: string; accountId: string };
  if (!userId) throw unauthorized("A signed-in teammate is required");
  return { userId, accountId };
};

const channelOf = (dependencies: EmailChannelRouteDependencies): EmailChannel => {
  if (!dependencies.emailChannel) {
    throw new AppError(503, "email_channel_not_configured", "The email channel is not configured in this deployment.");
  }
  return dependencies.emailChannel;
};

/** The settings card's overview; a deployment with no email provider answers with `configured: false`. */
const overviewOf = async (channel: EmailChannel | undefined, workspaceId: string) => {
  if (!channel) {
    return { configured: false, inboundDomain: null, supportedModes: [], defaultMode: null, domains: [], mailboxes: [] };
  }
  const [domains, mailboxes] = await Promise.all([
    channel.sendingDomains.list(workspaceId),
    channel.mailboxes.list(workspaceId),
  ]);
  return { configured: true, inboundDomain: channel.inboundDomain, ...channel.mailboxes.modes(), domains, mailboxes };
};

const handle = (work: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    work(req, res).catch(next);
  };

/**
 * The email channel's settings (`/workspaces/:workspaceId/email-channel`) and the inbox's email facts
 * for one conversation. Every route is session-only (apiPrincipalRoutePolicy.ts).
 */
export const createEmailChannelRoutes = (dependencies: EmailChannelRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const workspaceIdOf = (req: Request): string => uuidParam(req, "workspaceId");
  const settingsRead = requireWorkspacePermission(dependencies, "workspace.settings.read", workspaceIdOf);
  const settingsManage = requireWorkspacePermission(dependencies, "workspace.settings.manage", workspaceIdOf);
  // Raw customer mail is conversation content, so reading it also takes the inbox's permission.
  const rawMessageRead = requireWorkspacePermission(dependencies, "workspace.conversation.takeover", workspaceIdOf);
  const conversationRead = requireWorkspacePermission(dependencies, "workspace.conversation.takeover");
  const settings = "/workspaces/:workspaceId/email-channel";
  const mailbox = `${settings}/mailboxes/:mailboxId`;
  const domain = `${settings}/domains/:domainId`;
  const event = `${settings}/events/:deliveryId`;

  router.get(settings, workspaceSession, settingsRead, handle(async (req, res) => {
    res.status(200).json(await overviewOf(dependencies.emailChannel, workspaceIdOf(req)));
  }));

  router.post(`${settings}/mailboxes`, workspaceSession, settingsManage, validateBody(createEmailMailboxRequestSchema), handle(async (req, res) => {
    const body = req.body as z.infer<typeof createEmailMailboxRequestSchema>;
    res.status(201).json(await channelOf(dependencies).mailboxes.create(actorOf(res), workspaceIdOf(req), body));
  }));

  router.get(mailbox, workspaceSession, settingsRead, handle(async (req, res) => {
    res.status(200).json(await channelOf(dependencies).mailboxes.get(workspaceIdOf(req), uuidParam(req, "mailboxId")));
  }));

  router.patch(mailbox, workspaceSession, settingsManage, validateBody(updateEmailMailboxRequestSchema), handle(async (req, res) => {
    const body = req.body as z.infer<typeof updateEmailMailboxRequestSchema>;
    const updated = await channelOf(dependencies).mailboxes.update(actorOf(res), workspaceIdOf(req), uuidParam(req, "mailboxId"), body);
    res.status(200).json(updated);
  }));

  router.delete(mailbox, workspaceSession, settingsManage, handle(async (req, res) => {
    await channelOf(dependencies).mailboxes.remove(actorOf(res), workspaceIdOf(req), uuidParam(req, "mailboxId"));
    res.status(204).send();
  }));

  router.post(`${mailbox}/relay-token/rotate`, workspaceSession, settingsManage, handle(async (req, res) => {
    const rotated = await channelOf(dependencies).mailboxes.rotateRelayToken(actorOf(res), workspaceIdOf(req), uuidParam(req, "mailboxId"));
    res.status(200).json(rotated);
  }));

  router.post(`${mailbox}/setup-check`, workspaceSession, settingsManage, validateBody(startEmailMailboxSetupCheckRequestSchema), handle(async (req, res) => {
    const { step } = req.body as z.infer<typeof startEmailMailboxSetupCheckRequestSchema>;
    res.status(200).json(await channelOf(dependencies).mailboxes.startSetupCheck(workspaceIdOf(req), uuidParam(req, "mailboxId"), step));
  }));

  router.get(`${mailbox}/events`, workspaceSession, settingsRead, validateQuery(listEmailMailboxEventsQuerySchema), handle(async (req, res) => {
    const query = req.query as z.infer<typeof listEmailMailboxEventsQuerySchema>;
    res.status(200).json(await channelOf(dependencies).eventLog.list(workspaceIdOf(req), uuidParam(req, "mailboxId"), query));
  }));

  // The workspace's log keeps what no active mailbox shows: mail no mailbox matched, and a removed mailbox's events.
  router.get(`${settings}/events`, workspaceSession, settingsRead, validateQuery(listEmailChannelEventsQuerySchema), handle(async (req, res) => {
    const query = req.query as z.infer<typeof listEmailChannelEventsQuerySchema>;
    res.status(200).json(await channelOf(dependencies).eventLog.listWorkspace(workspaceIdOf(req), query));
  }));

  router.post(`${event}/retry`, workspaceSession, settingsManage, handle(async (req, res) => {
    const retried = await channelOf(dependencies).inboundEvents.retry(actorOf(res), workspaceIdOf(req), uuidParam(req, "deliveryId"));
    res.status(202).json(retried);
  }));

  router.get(`${event}/raw`, workspaceSession, settingsRead, rawMessageRead, handle(async (req, res) => {
    const view = await channelOf(dependencies).inboundEvents.openRawMessage(actorOf(res), workspaceIdOf(req), uuidParam(req, "deliveryId"));
    res.status(200).json(view);
  }));

  router.post(`${settings}/domains`, workspaceSession, settingsManage, validateBody(addEmailSendingDomainRequestSchema), handle(async (req, res) => {
    const { domain: name } = req.body as z.infer<typeof addEmailSendingDomainRequestSchema>;
    res.status(201).json(await channelOf(dependencies).sendingDomains.add(actorOf(res), workspaceIdOf(req), name));
  }));

  router.post(`${domain}/verify`, workspaceSession, settingsManage, handle(async (req, res) => {
    res.status(200).json(await channelOf(dependencies).sendingDomains.verify(actorOf(res), workspaceIdOf(req), uuidParam(req, "domainId")));
  }));

  // Adopts the provider's existing registration of a domain waiting for reconciliation.
  router.post(`${domain}/reconcile`, workspaceSession, settingsManage, handle(async (req, res) => {
    res.status(200).json(await channelOf(dependencies).sendingDomains.reconcile(actorOf(res), workspaceIdOf(req), uuidParam(req, "domainId")));
  }));

  router.post(`${domain}/receiving`, workspaceSession, settingsManage, validateBody(enableEmailDirectReceivingRequestSchema), handle(async (req, res) => {
    const { confirmation } = req.body as z.infer<typeof enableEmailDirectReceivingRequestSchema>;
    const enabled = await channelOf(dependencies).sendingDomains.enableReceiving(actorOf(res), workspaceIdOf(req), uuidParam(req, "domainId"), confirmation);
    res.status(200).json(enabled);
  }));

  router.delete(domain, workspaceSession, settingsManage, handle(async (req, res) => {
    await channelOf(dependencies).sendingDomains.remove(actorOf(res), workspaceIdOf(req), uuidParam(req, "domainId"));
    res.status(204).send();
  }));

  router.get("/conversations/:conversationId/email", workspaceSession, conversationRead, handle(async (req, res) => {
    const { workspaceId } = res.locals as { workspaceId: string };
    const facts = await dependencies.emailChannel?.conversationFacts.read(workspaceId, uuidParam(req, "conversationId"));
    if (!facts) throw notFound("Email conversation was not found");
    res.status(200).json(facts);
  }));

  return router;
};
