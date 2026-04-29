import nodemailer from "nodemailer";

import type { Env } from "../../../app/config/env.js";

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
  readonly sentMessages: EmailMessage[] = [];

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
    this.sentMessages.push(normalized);
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
      metadata: redactSensitiveEmailMetadata(message.metadata),
    });
  }
}

export class SmtpEmailDriver implements EmailDriver {
  private readonly transporter;

  constructor(input: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
  }) {
    this.transporter = nodemailer.createTransport({
      host: input.host,
      port: input.port,
      secure: input.secure,
      auth: {
        user: input.username,
        pass: input.password,
      },
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      to: message.to,
      from: message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}

export const createEmailService = (env: Env): EmailService => {
  const defaults = {
    fromEmail: env.MAIL_FROM_EMAIL,
    fromName: env.MAIL_FROM_NAME,
  };

  switch (env.MAIL_DRIVER) {
    case "noop":
      return new EmailService(new NoopEmailDriver(), defaults);
    case "smtp":
      return new EmailService(
        new SmtpEmailDriver({
          host: env.MAIL_SMTP_HOST!,
          port: env.MAIL_SMTP_PORT,
          secure: env.MAIL_SMTP_SECURE,
          username: env.MAIL_SMTP_USERNAME!,
          password: env.MAIL_SMTP_PASSWORD!,
        }),
        defaults,
      );
    case "log":
    default:
      return new EmailService(new LogEmailDriver(), defaults);
  }
};
