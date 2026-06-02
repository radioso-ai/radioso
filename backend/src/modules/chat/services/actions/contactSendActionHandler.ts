import type { ActionHandler, ActionHandlerContext } from "./actionDispatcher.js";

/**
 * Narrow mail port this handler needs — a host adapts its real mail transport to it.
 * Kept local so the handler depends on what it uses, not the app-wide transport type.
 */
export interface ContactNotificationMailer {
  send(message: { to: string; replyTo?: string | null; subject: string; text: string }): Promise<void>;
}

/**
 * Resolves where a workspace's contact notifications go. Injected because the
 * destination is host/product policy (workspace owner, a configured inbox, …), not
 * something this generic handler should hard-code. Returning null means "no recipient
 * configured" — the handler then no-ops rather than failing the request.
 */
export interface ContactRecipientResolver {
  resolve(context: ActionHandlerContext): Promise<string | null>;
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/**
 * The reference action handler for `contact.send`: emails a gathered contact request
 * (collected by the chat-only contact routine) to the workspace's resolved recipient.
 * Generic and self-contained — it reads the routine's variables off the payload and
 * sends through an injected mailer; it knows nothing about routines or the engine.
 *
 * Idempotent in practice: dispatch is keyed by the outbox idempotency key, so a
 * redelivered request with the same payload sends the same notification once. With no
 * recipient configured it no-ops (a missing destination is not a failure to retry).
 */
export class ContactSendActionHandler implements ActionHandler {
  constructor(
    private readonly mailer: ContactNotificationMailer,
    private readonly recipients: ContactRecipientResolver,
    private readonly logger?: { warn(payload: Record<string, unknown>, message: string): void },
  ) {}

  async handle(input: { payload: Record<string, unknown>; context: ActionHandlerContext }): Promise<void> {
    const to = await this.recipients.resolve(input.context);
    if (!to) {
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

    await this.mailer.send({
      to,
      replyTo: email,
      subject: "New contact request",
      text: lines.join("\n"),
    });
  }
}
