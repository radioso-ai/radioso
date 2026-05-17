import { ResendEmailDriver } from "./adapters/resendDriver.js";

export interface EmailMessage {
  to: string;
  from: {
    email: string;
    name?: string | null;
  };
  replyTo?: string | null;
  subject: string;
  text: string;
  html?: string;
  metadata?: Record<string, string>;
}

export interface EmailDriver {
  send(message: EmailMessage): Promise<void>;
}

export interface PasswordResetEmailInput {
  to: string;
  resetUrl: string;
}

export interface EmailVerificationInput {
  to: string;
  verificationUrl: string;
}

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

export class EmailService {
  constructor(
    private readonly driver: EmailDriver,
    private readonly defaults: {
      fromEmail: string;
      fromName?: string | null;
    },
  ) {}

  async send(message: Omit<EmailMessage, "from"> & { from?: EmailMessage["from"] }): Promise<void> {
    const normalized: EmailMessage = {
      ...message,
      from: message.from ?? {
        email: this.defaults.fromEmail,
        name: this.defaults.fromName ?? null,
      },
    };
    await this.driver.send(normalized);
  }

  async sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<void> {
    await this.send({
      to: input.to,
      subject: "Reset your password",
      text: [
        "We received a request to reset your Radioso password.",
        "",
        `Use this link to choose a new password: ${input.resetUrl}`,
        "",
        "If you did not request this, you can ignore this email.",
      ].join("\n"),
      html: [
        "<p>We received a request to reset your Radioso password.</p>",
        `<p><a href="${input.resetUrl}">Use this link to choose a new password</a>.</p>`,
        "<p>If you did not request this, you can ignore this email.</p>",
      ].join(""),
      metadata: {
        kind: "password_reset",
        resetUrl: input.resetUrl,
      },
    });
  }

  async sendEmailVerificationEmail(input: EmailVerificationInput): Promise<void> {
    await this.send({
      to: input.to,
      subject: "Verify your email",
      text: [
        "Welcome to Radioso.",
        "",
        `Verify your email address to finish setting up your account: ${input.verificationUrl}`,
        "",
        "If you did not create this account, you can ignore this email.",
      ].join("\n"),
      html: [
        "<p>Welcome to Radioso.</p>",
        `<p><a href="${input.verificationUrl}">Verify your email address</a> to finish setting up your account.</p>`,
        "<p>If you did not create this account, you can ignore this email.</p>",
      ].join(""),
      metadata: {
        kind: "email_verification",
        verificationUrl: input.verificationUrl,
      },
    });
  }

  async sendHumanContactRequestEmail(input: HumanContactRequestEmailInput): Promise<void> {
    const message = renderHumanContactRequestEmail(input);
    await this.send(message);
  }
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
): Omit<EmailMessage, "from"> => {
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

export class NoopEmailDriver implements EmailDriver {
  async send(_message: EmailMessage): Promise<void> {}
}

const SENSITIVE_METADATA_KEYS = new Set(["resetUrl", "verificationUrl"]);

const redactSensitiveEmailMetadata = (
  metadata: Record<string, string> | undefined,
): Record<string, string> | undefined => {
  if (!metadata) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      SENSITIVE_METADATA_KEYS.has(key) ? "[redacted]" : value,
    ]),
  );
};

export class LogEmailDriver implements EmailDriver {
  async send(message: EmailMessage): Promise<void> {
    console.info("email.send", {
      to: message.to,
      replyTo: message.replyTo ?? null,
      subject: message.subject,
      text: message.text,
      metadata: redactSensitiveEmailMetadata(message.metadata),
    });
  }
}

export interface MailEnv {
  EE_MAIL_DRIVER?: string;
  EE_MAIL_FROM_EMAIL?: string;
  EE_MAIL_FROM_NAME?: string;
  RESEND_MAIL_API_KEY?: string;
}

export const createMailService = (source: MailEnv = process.env): EmailService => {
  const resendApiKey = source.RESEND_MAIL_API_KEY?.trim();
  const driverName = source.EE_MAIL_DRIVER ?? (resendApiKey ? "resend" : "log");
  const fromEmail = source.EE_MAIL_FROM_EMAIL ?? "noreply@example.com";
  const fromName = source.EE_MAIL_FROM_NAME ?? "Radioso";

  if (driverName === "resend") {
    if (!resendApiKey) {
      throw new Error("RESEND_MAIL_API_KEY is required when EE_MAIL_DRIVER is resend");
    }
    return new EmailService(new ResendEmailDriver(resendApiKey), { fromEmail, fromName });
  }
  if (driverName === "noop") {
    return new EmailService(new NoopEmailDriver(), { fromEmail, fromName });
  }
  if (driverName === "log") {
    return new EmailService(new LogEmailDriver(), { fromEmail, fromName });
  }
  throw new Error(`Unsupported EE_MAIL_DRIVER "${driverName}"`);
};
