import type { EmailMessage } from "../emailService.js";
import { renderEmail, renderEmailText, type EmailContent } from "./layout.js";

interface ConversationTransferEmailInput {
  to: string;
  /** Public frontend origin; the layout serves the brand lockup from it. */
  appBaseUrl?: string | null;
  /** Dashboard permalink to the conversation. Null when no link can be produced; the notice still goes out. */
  conversationUrl: string | null;
  /** The teammate label of whoever handed the conversation over, when they can still be named. */
  transferredByLabel: string | null;
  workspaceName: string | null;
}

/**
 * Tells a teammate a conversation is now theirs. Carries who handed it over, the workspace, and
 * the dashboard link — never the transcript, which stays behind the dashboard's access checks.
 */
export const renderConversationTransferEmail = (
  input: ConversationTransferEmailInput,
): Omit<EmailMessage, "from"> => {
  const handedBy = input.transferredByLabel
    ? `${input.transferredByLabel} handed you a conversation.`
    : "A teammate handed you a conversation.";

  const content: EmailContent = {
    preheader: "You are now handling it.",
    heading: "A conversation is yours",
    paragraphs: [handedBy, "You are now the teammate handling it. Open it to read the thread and reply."],
    ...(input.conversationUrl ? { cta: { href: input.conversationUrl, label: "Open conversation" } } : {}),
    ...(input.workspaceName ? { metaRows: [{ label: "Workspace", value: input.workspaceName }] } : {}),
  };

  return {
    to: input.to,
    subject: "A conversation was handed to you",
    text: renderEmailText(content),
    html: renderEmail(content, { appBaseUrl: input.appBaseUrl }),
    kind: "conversation_transfer",
  };
};
