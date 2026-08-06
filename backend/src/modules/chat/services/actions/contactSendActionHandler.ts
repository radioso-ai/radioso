import { readNotifyContactDelivery } from "../../../agents/public.js";
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
  }): Promise<void>;
}

export interface ContactDeliveryTarget {
  emails: string[];
  webhook: AgentContactWebhook | null;
}

/**
 * Resolves where a workspace's contact notifications go. Injected because the
 * destination is host/product policy (workspace owner, configured inboxes, webhook),
 * not something this generic handler should hard-code.
 */
export interface ContactRecipientResolver {
  resolve(context: ActionHandlerContext): Promise<ContactDeliveryTarget>;
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
    config?: Record<string, unknown>;
  } | null>;
}

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
export class WorkspaceOwnerContactRecipientResolver implements ContactRecipientResolver {
  constructor(
    private readonly workspaces: ContactWorkspaceLookup,
    private readonly members: ContactMembershipLookup,
  ) {}

  async resolve(context: ActionHandlerContext): Promise<ContactDeliveryTarget> {
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

export class ConfiguredContactDeliveryResolver implements ContactRecipientResolver {
  constructor(
    private readonly conversations: ContactConversationLookup,
    private readonly agents: ContactAgentLookup,
    private readonly fallback: ContactRecipientResolver,
    private readonly notifySkills?: ContactNotifySkillLookup,
  ) {}

  async resolve(context: ActionHandlerContext): Promise<ContactDeliveryTarget> {
    if (!context.workspaceId || !context.conversationId) {
      return this.fallback.resolve(context);
    }
    const conversation = await this.conversations.findByIdAndWorkspaceId(context.conversationId, context.workspaceId);
    if (!conversation?.agentId) {
      return this.fallback.resolve(context);
    }
    const notifySkill = await this.notifySkills?.findByName(context.workspaceId, conversation.agentId, "contact_human");
    if (notifySkill?.kind === "notify") {
      if (!notifySkill.enabled) {
        return { emails: [], webhook: null };
      }
      const delivery = readNotifyContactDelivery(notifySkill.config);
      if (delivery) {
        if (delivery.recipientEmails.length > 0) {
          return {
            emails: delivery.recipientEmails,
            webhook: delivery.webhook,
          };
        }
        const fallback = await this.fallback.resolve(context);
        return {
          emails: fallback.emails,
          webhook: delivery.webhook,
        };
      }
    }
    const agent = await this.agents.findByIdAndWorkspaceId(conversation.agentId, context.workspaceId);
    if (!agent) {
      return this.fallback.resolve(context);
    }

    const configured = agent.contactRequestDelivery;
    if (configured.recipientEmails.length > 0) {
      return {
        emails: configured.recipientEmails,
        webhook: configured.webhook,
      };
    }

    const fallback = await this.fallback.resolve(context);
    return {
      emails: fallback.emails,
      webhook: configured.webhook,
    };
  }
}


export class FetchContactWebhookHttpClient extends FetchWebhookHttpClient {}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

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
   * it without logging the visitor's email, name, or message — only correlation ids
   * and the handler's own error string (already durable in the outbox's `last_error`
   * column regardless of this call).
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
        error: new Error(input.error),
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
