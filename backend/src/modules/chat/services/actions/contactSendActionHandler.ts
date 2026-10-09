import { hasConfiguredContactDestination, readNotifyContactDelivery } from "../../../agents/public.js";
import type { AgentContactRequestDelivery, AgentContactWebhook } from "../../../agents/public.js";
import type { ActionFailureOutcome } from "../../../../db/repositories/actionRequestRepository.js";
import type { ErrorReporter } from "../../../../shared/errors/errorReporter.js";
import type { ActionHandler, ActionHandlerContext } from "./actionDispatcher.js";
import {
  FetchWebhookHttpClient,
  type WebhookHttpClient,
  type WebhookUrlGuard,
} from "./webhookDelivery.js";

/**
 * Narrow mail port this handler needs — a host adapts its real mail transport to it.
 * Kept local so the handler depends on what it uses, not the app-wide transport type.
 */
export interface ContactNotificationMailer {
  send(message: {
    to: string;
    replyTo?: string | null;
    subject: string;
    text: string;
    idempotencyKey?: string | null;
    // The result is deliberately unconstrained: this handler needs the send to happen and
    // does not read what the transport reports back.
  }): Promise<unknown>;
}

export interface ContactDeliveryTarget {
  emails: string[];
  webhook: AgentContactWebhook | null;
}

/**
 * Which rule picked a destination, in precedence order: the notify skill the request names, the
 * agent's `contact_human` skill (or that skill turned off, which sends nothing), the agent's
 * contact settings, the workspace owner or admin, or nobody at all.
 */
export type ContactDeliveryRoute =
  | "named_skill"
  | "contact_human"
  | "contact_human_off"
  | "agent_setting"
  | "workspace_owner"
  | "none";

export interface RoutedContactDeliveryTarget extends ContactDeliveryTarget {
  via: ContactDeliveryRoute;
  /** The emails are the workspace owner's because the chosen route lists no recipients of its own. */
  recipientsFromWorkspaceOwner: boolean;
}

/**
 * Resolves where a workspace's contact notifications go. Injected because the
 * destination is host/product policy (workspace owner, configured inboxes, webhook),
 * not something this generic handler should hard-code.
 */
export interface ContactRecipientResolver {
  resolve(context: ActionHandlerContext): Promise<ContactDeliveryTarget>;
}

/** A {@link ContactRecipientResolver} that also says which rule picked the destination. */
export interface RoutedContactRecipientResolver extends ContactRecipientResolver {
  resolve(context: ActionHandlerContext): Promise<RoutedContactDeliveryTarget>;
}

/** The last-resort recipient when no route configures one; only the workspace is known. */
export interface ContactOwnerFallback {
  resolve(context: Pick<ActionHandlerContext, "workspaceId">): Promise<ContactDeliveryTarget>;
}

export interface ContactConversationLookup {
  findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<{ agentId: string | null } | null>;
}

export interface ContactAgentLookup {
  findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<{
    contactRequestDelivery: AgentContactRequestDelivery;
  } | null>;
}

export interface ContactNotifySkillLookup {
  findByName(workspaceId: string, agentId: string, skillName: string): Promise<{
    kind: string;
    enabled: boolean;
    invocationMode: string;
    config?: Record<string, unknown>;
  } | null>;
}

/**
 * A notify skill a request may be routed through by name: the same enabled, routine-named notify
 * skills the routine authoring catalog offers, so what an author can pick is what delivery honours.
 */
const isNameableNotifySkill = (
  skill: Awaited<ReturnType<ContactNotifySkillLookup["findByName"]>> | undefined,
): skill is NonNullable<typeof skill> =>
  skill?.kind === "notify" && skill.enabled && skill.invocationMode === "routine_named";

export type ContactWebhookHttpClient = WebhookHttpClient;

/**
 * Asserts an outbound URL resolves to a publicly routable host (SSRF guard). A host
 * adapts the website crawler's `assertPublicWebsiteUrl` to it so this module does not
 * depend on the crawler. Throwing rejects the URL; the worker then retries/fails.
 */
export type ContactWebhookUrlGuard = WebhookUrlGuard;

/** Narrow lookups the workspace-owner resolver needs (a `WorkspaceRepository` satisfies it). */
export interface ContactWorkspaceLookup {
  findById(workspaceId: string): Promise<{ accountId: string } | null>;
}
/** Narrow lookup for an account's active members (an `AccountMembershipRepository` satisfies it). */
export interface ContactMembershipLookup {
  listActiveByAccount(accountId: string): Promise<{ role: string; email: string }[]>;
}

/**
 * The default generic recipient: the workspace owner's email (falling back to an admin).
 * A sensible destination with no extra configuration — a host that wants a dedicated
 * contact inbox registers its own {@link ContactRecipientResolver} instead.
 */
export class WorkspaceOwnerContactRecipientResolver implements ContactRecipientResolver, ContactOwnerFallback {
  constructor(
    private readonly workspaces: ContactWorkspaceLookup,
    private readonly members: ContactMembershipLookup,
  ) {}

  async resolve(context: Pick<ActionHandlerContext, "workspaceId">): Promise<ContactDeliveryTarget> {
    if (!context.workspaceId) {
      return { emails: [], webhook: null };
    }
    const workspace = await this.workspaces.findById(context.workspaceId);
    if (!workspace) {
      return { emails: [], webhook: null };
    }
    const active = await this.members.listActiveByAccount(workspace.accountId);
    const owner = active.find((member) => member.role === "owner")
      ?? active.find((member) => member.role === "admin");
    return { emails: owner?.email ? [owner.email] : [], webhook: null };
  }
}

export class ConfiguredContactDeliveryResolver implements RoutedContactRecipientResolver {
  constructor(
    private readonly conversations: ContactConversationLookup,
    private readonly agents: ContactAgentLookup,
    private readonly fallback: ContactOwnerFallback,
    private readonly notifySkills?: ContactNotifySkillLookup,
  ) {}

  /** Where a queued request goes: its conversation's agent decides, through {@link resolveForAgent}. */
  async resolve(context: ActionHandlerContext): Promise<RoutedContactDeliveryTarget> {
    if (!context.workspaceId || !context.conversationId) {
      return this.workspaceOwnerTarget(context.workspaceId);
    }
    const conversation = await this.conversations.findByIdAndWorkspaceId(context.conversationId, context.workspaceId);
    if (!conversation?.agentId) {
      return this.workspaceOwnerTarget(context.workspaceId);
    }
    return this.resolveForAgent({
      workspaceId: context.workspaceId,
      agentId: conversation.agentId,
      skillName: context.skillName,
    });
  }

  /**
   * Where a request from this agent goes, optionally routed through a named notify skill. The one
   * statement of contact precedence: delivery calls it for a queued request, and the dashboard calls
   * it to show an operator where a notice will be sent before anything is.
   */
  async resolveForAgent(input: {
    workspaceId: string;
    agentId: string;
    skillName: string | null;
  }): Promise<RoutedContactDeliveryTarget> {
    // The skill a request names (an outbox row's skill_name, or the notify skill an ending's notice
    // names) wins over the `contact_human` lookup below: two notify skills on one agent must be
    // able to deliver to different recipients, not collide on one shared config.
    //
    // A named skill that is gone, turned off, or no longer routine-named falls through to the
    // lookups below instead of short-circuiting to no recipient (unlike the `contact_human` branch,
    // which does short-circuit). `contact_human` is one well-known skill an operator turns off
    // deliberately, expecting contact requests to stop; a named skill going away is more likely a
    // rename or an authoring change, and a request routed through it must still reach somebody.
    if (input.skillName) {
      const namedSkill = await this.notifySkills?.findByName(input.workspaceId, input.agentId, input.skillName);
      const delivery = isNameableNotifySkill(namedSkill) ? readNotifyContactDelivery(namedSkill.config) : null;
      if (delivery) {
        return this.resolveConfiguredDelivery(delivery, "named_skill", input.workspaceId);
      }
    }

    const notifySkill = await this.notifySkills?.findByName(input.workspaceId, input.agentId, "contact_human");
    if (notifySkill?.kind === "notify") {
      if (!notifySkill.enabled) {
        return { emails: [], webhook: null, via: "contact_human_off", recipientsFromWorkspaceOwner: false };
      }
      const delivery = readNotifyContactDelivery(notifySkill.config);
      if (delivery) {
        return this.resolveConfiguredDelivery(delivery, "contact_human", input.workspaceId);
      }
    }
    const agent = await this.agents.findByIdAndWorkspaceId(input.agentId, input.workspaceId);
    if (!agent || !hasConfiguredContactDestination(agent.contactRequestDelivery)) {
      return this.workspaceOwnerTarget(input.workspaceId);
    }
    return this.resolveConfiguredDelivery(agent.contactRequestDelivery, "agent_setting", input.workspaceId);
  }

  /** Configured recipients win; empty recipients fall back to the owner while keeping the configured webhook. */
  private async resolveConfiguredDelivery(
    delivery: AgentContactRequestDelivery,
    via: ContactDeliveryRoute,
    workspaceId: string,
  ): Promise<RoutedContactDeliveryTarget> {
    if (delivery.recipientEmails.length > 0) {
      return { emails: delivery.recipientEmails, webhook: delivery.webhook, via, recipientsFromWorkspaceOwner: false };
    }
    const owner = await this.fallback.resolve({ workspaceId });
    return { emails: owner.emails, webhook: delivery.webhook, via, recipientsFromWorkspaceOwner: owner.emails.length > 0 };
  }

  private async workspaceOwnerTarget(workspaceId: string | null): Promise<RoutedContactDeliveryTarget> {
    const owner = await this.fallback.resolve({ workspaceId });
    if (owner.emails.length === 0 && !owner.webhook) {
      return { emails: [], webhook: null, via: "none", recipientsFromWorkspaceOwner: false };
    }
    return { ...owner, via: "workspace_owner", recipientsFromWorkspaceOwner: owner.emails.length > 0 };
  }
}


export class FetchContactWebhookHttpClient extends FetchWebhookHttpClient {}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/**
 * A caught delivery failure's HTTP status, if the (already-stringified, see
 * {@link ActionDispatcher}) error text ends in one — `ResendEmailDeliveryError`
 * and the webhook client's own errors both format theirs this way. Structural,
 * not content-based: it never echoes the surrounding text, only a 3-digit code.
 */
const trailingStatusCode = (message: string): number | undefined => {
  const match = /\b([1-5]\d{2})\D*$/u.exec(message);
  return match ? Number(match[1]) : undefined;
};

/** A bounded, non-free-text classification of a caught delivery failure — see the
 * {@link ContactSendActionHandler.recordFailureOutcome} doc comment for why the
 * raw caught error text must not reach {@link ErrorReporter}. */
class ContactSendDeliveryFailureError extends Error {
  constructor(statusCode: number | undefined) {
    super(statusCode ? `contact.send delivery failed with status ${statusCode}` : "contact.send delivery failed");
    this.name = "ContactSendDeliveryFailure";
  }
}

/**
 * The reference action handler for `contact.send`: emails a gathered contact request
 * (collected by the chat-only contact routine) to the workspace's resolved recipient.
 * Generic and self-contained — it reads the routine's variables off the payload and
 * sends through an injected mailer; it knows nothing about routines or the engine.
 *
   * Dispatch supplies the outbox idempotency key and the mail transport forwards it to
   * providers that support send de-duplication. With no recipient configured it no-ops
   * (a missing destination is not a failure to retry).
 */
export class ContactSendActionHandler implements ActionHandler {
  constructor(
    private readonly mailer: ContactNotificationMailer,
    private readonly recipients: ContactRecipientResolver,
    private readonly logger?: { warn(payload: Record<string, unknown>, message: string): void },
    private readonly webhookClient?: ContactWebhookHttpClient,
    // Terminal (retry-budget-exhausted) failures are alertable — see recordFailureOutcome.
    private readonly errorReporter?: ErrorReporter,
  ) {}

  async handle(input: { payload: Record<string, unknown>; context: ActionHandlerContext }): Promise<void> {
    const target = await this.recipients.resolve(input.context);
    if (target.emails.length === 0 && !target.webhook) {
      this.logger?.warn(
        { workspaceId: input.context.workspaceId, conversationId: input.context.conversationId },
        "contact.send: no recipient configured for workspace; skipping",
      );
      return;
    }

    const email = asString(input.payload.email);
    const message = asString(input.payload.message) ?? "";
    const name = asString(input.payload.name);

    const lines = [
      name ? `Name: ${name}` : null,
      email ? `Email: ${email}` : null,
      "",
      message,
    ].filter((line): line is string => line !== null);

    const baseIdempotencyKey = input.context.idempotencyKey ?? input.context.requestId;
    await Promise.all([
      ...target.emails.map((to) =>
        this.mailer.send({
          to,
          replyTo: email,
          subject: "New contact request",
          text: lines.join("\n"),
          idempotencyKey: `${baseIdempotencyKey}:email:${encodeURIComponent(to)}`,
        })),
      target.webhook ? this.postWebhook({
        webhook: target.webhook,
        payload: {
          name,
          email,
          message,
          workspaceId: input.context.workspaceId,
          conversationId: input.context.conversationId,
          requestId: input.context.requestId,
        },
        idempotencyKey: `${baseIdempotencyKey}:webhook`,
      }) : Promise.resolve(),
    ]);
  }

  private async postWebhook(input: {
    webhook: AgentContactWebhook;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<void> {
    if (!this.webhookClient) {
      throw new Error("Contact webhook delivery is not configured");
    }
    // No signature: receivers are expected to treat the URL itself as the shared
    // secret (it is operator-configured and not exposed). The idempotency key lets a
    // receiver de-duplicate at-least-once redeliveries.
    await this.webhookClient.post({
      url: input.webhook.url,
      rawBody: JSON.stringify(input.payload),
      headers: { "Idempotency-Key": input.idempotencyKey },
    });
  }

  /**
   * Only a terminal (`failed`, retry budget exhausted) outcome is alertable — a
   * `retry` is expected, transient behavior the dispatcher already handles. Before
   * this, a permanently failed contact.send produced no log and no error report (the
   * gap that let the outbox drain outage go unnoticed for two months); this closes
   * it without logging the visitor's email, name, or message.
   *
   * `input.error` is the dispatcher's caught-and-stringified error text — this
   * handler's own bounded messages today, but it flows from an injected
   * {@link ContactNotificationMailer} / {@link ContactWebhookHttpClient}, so a
   * host-supplied transport could echo a provider response body, a reply-to
   * address, or a webhook URL with a token in its query string. The error
   * reporter is an external sink, so that raw text must never reach it — only a
   * bounded classification (a status code, when the text ends in one) does. The
   * full text remains available for operator debugging in the outbox's
   * `last_error` column (see {@link ActionDispatcher.onFailure}), untouched by
   * this call.
   */
  async recordFailureOutcome(input: {
    payload: Record<string, unknown>;
    context: ActionHandlerContext;
    outcome: Exclude<ActionFailureOutcome, "superseded">;
    error: string;
  }): Promise<void> {
    if (input.outcome !== "failed") {
      return;
    }
    this.logger?.warn(
      {
        workspaceId: input.context.workspaceId,
        conversationId: input.context.conversationId,
        requestId: input.context.requestId,
        attempt: input.context.attempt,
      },
      "contact.send delivery permanently failed after exhausting retries",
    );
    try {
      await this.errorReporter?.report({
        errorType: "action.contact_send.delivery_failed",
        error: new ContactSendDeliveryFailureError(trailingStatusCode(input.error)),
        severity: "error",
        metadata: {
          workspaceId: input.context.workspaceId ?? undefined,
          conversationId: input.context.conversationId ?? undefined,
          requestId: input.context.requestId,
        },
      });
    } catch {
      // The warn log above is already the durable trail; a reporting-sink outage
      // must not surface as a second failure on top of the delivery failure itself.
    }
  }
}
