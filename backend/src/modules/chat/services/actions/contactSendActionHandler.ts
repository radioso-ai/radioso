import { createHmac } from "node:crypto";

import type { AgentContactRequestDelivery, AgentContactWebhook } from "../../../agents/public.js";
import type { ActionHandler, ActionHandlerContext } from "./actionDispatcher.js";

const CONTACT_WEBHOOK_SIGNATURE_KEY_LABEL = "radioso/contact-webhook-signature/v1";

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

export interface ContactWebhookHttpClient {
  post(request: {
    url: string;
    /** The exact bytes to send — already serialized and signed, so what we sign is what we send. */
    rawBody: string;
    headers: Record<string, string>;
  }): Promise<void>;
}

/**
 * Asserts an outbound URL resolves to a publicly routable host (SSRF guard). A host
 * adapts the website crawler's `assertPublicWebsiteUrl` to it so this module does not
 * depend on the crawler. Throwing rejects the URL; the worker then retries/fails.
 */
export type ContactWebhookUrlGuard = (url: string) => Promise<void>;

export interface ContactWebhookSigner {
  sign(value: string): string;
}

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
  ) {}

  async resolve(context: ActionHandlerContext): Promise<ContactDeliveryTarget> {
    if (!context.workspaceId || !context.conversationId) {
      return this.fallback.resolve(context);
    }
    const conversation = await this.conversations.findByIdAndWorkspaceId(context.conversationId, context.workspaceId);
    if (!conversation?.agentId) {
      return this.fallback.resolve(context);
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

export class ContactWebhookHmacSigner implements ContactWebhookSigner {
  constructor(private readonly signingKey: Buffer) {}

  sign(rawBody: string): string {
    return createHmac("sha256", this.signingKey).update(rawBody).digest("base64url");
  }
}

export const deriveContactWebhookSigningKey = (workspaceTokenSecret: string): Buffer =>
  createHmac("sha256", workspaceTokenSecret).update(CONTACT_WEBHOOK_SIGNATURE_KEY_LABEL).digest();

/** Default per-request webhook timeout — a slow endpoint must not stall action dispatch. */
const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
/** A webhook should normally not redirect; allow a couple of hops but cap them. */
const DEFAULT_MAX_WEBHOOK_REDIRECTS = 3;

export class FetchContactWebhookHttpClient implements ContactWebhookHttpClient {
  constructor(
    private readonly assertPublicUrl: ContactWebhookUrlGuard,
    private readonly options: { timeoutMs?: number; maxRedirects?: number } = {},
  ) {}

  async post(request: { url: string; rawBody: string; headers: Record<string, string> }): Promise<void> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
    const maxRedirects = this.options.maxRedirects ?? DEFAULT_MAX_WEBHOOK_REDIRECTS;
    let currentUrl = request.url;

    // Walk redirects manually and re-validate every hop against the SSRF policy
    // BEFORE the request leaves the worker. `redirect: "follow"` would let fetch
    // chase a 3xx to a private/link-local host (e.g. cloud metadata) before we
    // could check it. A bounded timeout per hop keeps one slow endpoint from
    // stalling the dispatch batch.
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      await this.assertPublicUrl(currentUrl);
      const response = await fetch(currentUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...request.headers },
        body: request.rawBody,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`Contact webhook redirect (${response.status}) had no location`);
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!response.ok) {
        throw new Error(`Contact webhook POST failed with status ${response.status}`);
      }
      return;
    }
    throw new Error(`Contact webhook exceeded ${maxRedirects} redirects`);
  }
}

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
    private readonly webhookSigner?: ContactWebhookSigner,
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
    if (!this.webhookClient || !this.webhookSigner) {
      throw new Error("Contact webhook delivery is not configured");
    }
    const rawBody = JSON.stringify(input.payload);
    const timestamp = String(Date.now());
    // Sign timestamp AND body together so a receiver can trust the timestamp for
    // replay protection — altering it invalidates the signature. The signed bytes
    // are exactly the bytes we send (rawBody), so receivers verify over the raw body.
    const signature = this.webhookSigner.sign(`${timestamp}.${rawBody}`);
    await this.webhookClient.post({
      url: input.webhook.url,
      rawBody,
      headers: {
        "X-Radioso-Signature": signature,
        "X-Radioso-Timestamp": timestamp,
        "Idempotency-Key": input.idempotencyKey,
      },
    });
  }
}
