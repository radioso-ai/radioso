export interface EmailMessage {
  to: string;
  from: {
    email: string;
    name?: string | null;
  };
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
}

export class NoopEmailDriver implements EmailDriver {
  async send(_message: EmailMessage): Promise<void> {}
}

const redactSensitiveEmailMetadata = (
  metadata: Record<string, string> | undefined,
): Record<string, string> | undefined => {
  if (!metadata) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      key === "resetUrl" || key === "verificationUrl" ? "[redacted]" : value,
    ]),
  );
};

export class LogEmailDriver implements EmailDriver {
  async send(message: EmailMessage): Promise<void> {
    console.info("email.send", {
      to: message.to,
      subject: message.subject,
      text: message.text,
      metadata: redactSensitiveEmailMetadata(message.metadata),
    });
  }
}

export class ResendEmailDriver implements EmailDriver {
  constructor(private readonly apiKey: string) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Resend email delivery failed with status ${response.status}: ${detail}`);
    }
  }
}

export interface EnterpriseEmailEnv {
  EE_MAIL_DRIVER?: string;
  EE_MAIL_FROM_EMAIL?: string;
  EE_MAIL_FROM_NAME?: string;
  RESEND_MAIL_API_KEY?: string;
}

export const createEnterpriseEmailService = (
  source: EnterpriseEmailEnv = process.env,
): EmailService => {
  const resendApiKey = source.RESEND_MAIL_API_KEY?.trim();
  const driverName = source.EE_MAIL_DRIVER ?? (resendApiKey ? "resend" : "log");
  const fromEmail = source.EE_MAIL_FROM_EMAIL ?? "noreply@example.com";
  const fromName = source.EE_MAIL_FROM_NAME ?? "Radioso";

  if (driverName === "resend") {
    if (!resendApiKey) {
      throw new Error("RESEND_MAIL_API_KEY is required when EE_MAIL_DRIVER is resend");
    }

    return new EmailService(new ResendEmailDriver(resendApiKey), {
      fromEmail,
      fromName,
    });
  }

  if (driverName === "noop") {
    return new EmailService(new NoopEmailDriver(), {
      fromEmail,
      fromName,
    });
  }

  if (driverName === "log") {
    return new EmailService(new LogEmailDriver(), {
      fromEmail,
      fromName,
    });
  }

  throw new Error(`Unsupported EE_MAIL_DRIVER "${driverName}"`);
};
