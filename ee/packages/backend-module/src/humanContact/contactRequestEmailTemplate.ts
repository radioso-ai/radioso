export interface HumanContactRequestEmailInput {
  to: string;
  visitorEmail: string;
  message: string;
  workspace: { name: string; publicRouteKey: string } | null;
  sourceChannel: string | null;
  createdAt: Date | string;
  requestId: string;
  workspaceId: string;
  dashboardUrl: string | null;
}

export interface RenderedContactRequestEmail {
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  html: string;
  metadata: Record<string, string>;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatTimestamp = (value: Date | string): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
};

const SOURCE_CHANNEL_LABELS: Record<string, string> = {
  authenticated_chat: "dashboard chat",
  website_embed: "website embed",
  public_chat: "public chat link",
  api: "API",
};

const formatSourceChannel = (channel: string | null): string | null => {
  if (!channel) {
    return null;
  }
  return SOURCE_CHANNEL_LABELS[channel] ?? channel.replace(/_/g, " ");
};

export const renderHumanContactRequestEmail = (
  input: HumanContactRequestEmailInput,
): RenderedContactRequestEmail => {
  const workspaceLabel = input.workspace?.name ?? "your workspace";
  const sourceLabel = formatSourceChannel(input.sourceChannel);
  const timestamp = formatTimestamp(input.createdAt);
  const subjectWorkspace = input.workspace?.name ? `[${input.workspace.name}] ` : "";
  const subject = `${subjectWorkspace}New contact request from ${input.visitorEmail}`;

  const metaLine = [workspaceLabel, sourceLabel ? `via ${sourceLabel}` : null, timestamp || null]
    .filter((part): part is string => Boolean(part))
    .join(" • ");

  const textLines = [
    `New contact request — ${metaLine}`,
    "",
    `From: ${input.visitorEmail}`,
    "",
    "Message:",
    input.message || "(no message)",
  ];
  if (input.dashboardUrl) {
    textLines.push("", `Open in Radioso: ${input.dashboardUrl}`);
  }
  textLines.push("", `— Request ${input.requestId}`);

  const htmlParts: string[] = [];
  htmlParts.push(
    `<p style="margin:0 0 4px 0;color:#6b7280;font-size:12px;">${escapeHtml(metaLine)}</p>`,
  );
  htmlParts.push(`<h2 style="margin:0 0 16px 0;font-size:18px;">New contact request</h2>`);
  htmlParts.push(
    `<p style="margin:0 0 8px 0;"><strong>From:</strong> <a href="mailto:${escapeHtml(input.visitorEmail)}">${escapeHtml(input.visitorEmail)}</a></p>`,
  );
  htmlParts.push(
    `<p style="margin:0 0 4px 0;"><strong>Message:</strong></p><p style="margin:0 0 16px 0;white-space:pre-wrap;">${escapeHtml(input.message || "(no message)")}</p>`,
  );
  if (input.dashboardUrl) {
    htmlParts.push(
      `<p style="margin:0 0 16px 0;"><a href="${escapeHtml(input.dashboardUrl)}" style="display:inline-block;padding:8px 14px;background:#111827;color:#ffffff;border-radius:6px;text-decoration:none;">Open in Radioso</a></p>`,
    );
  }
  htmlParts.push(
    `<p style="margin:24px 0 0 0;color:#9ca3af;font-size:11px;">Request ID: ${escapeHtml(input.requestId)}</p>`,
  );

  return {
    to: input.to,
    replyTo: input.visitorEmail,
    subject,
    text: textLines.join("\n"),
    html: htmlParts.join(""),
    metadata: {
      kind: "human_contact_request",
      requestId: input.requestId,
      workspaceId: input.workspaceId,
    },
  };
};
