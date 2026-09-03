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
  idempotencyKey?: string | null;
}

export interface EmailSendResult {
  /**
   * True only when a mail provider accepted the message. Drivers that merely record it
   * report false, so no caller can claim an unsent message reached its recipient.
   */
  dispatched: boolean;
}

export interface EmailDriver {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export class EmailService {
  constructor(
    private readonly driver: EmailDriver,
    private readonly defaults: {
      fromEmail: string;
      fromName?: string | null;
    },
  ) {}

  async send(
    message: Omit<EmailMessage, "from"> & { from?: EmailMessage["from"] },
  ): Promise<EmailSendResult> {
    const normalized: EmailMessage = {
      ...message,
      from: message.from ?? {
        email: this.defaults.fromEmail,
        name: this.defaults.fromName ?? null,
      },
    };
    return this.driver.send(normalized);
  }
}

export class NoopEmailDriver implements EmailDriver {
  async send(_message: EmailMessage): Promise<EmailSendResult> {
    return { dispatched: false };
  }
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
  async send(message: EmailMessage): Promise<EmailSendResult> {
    console.info("email.send", {
      to: message.to,
      replyTo: message.replyTo ?? null,
      subject: message.subject,
      text: message.text,
      metadata: redactSensitiveEmailMetadata(message.metadata),
      idempotencyKey: message.idempotencyKey ?? null,
    });
    return { dispatched: false };
  }
}

export interface MailEnv {
  MAIL_DRIVER?: string;
  MAIL_FROM_EMAIL?: string;
  MAIL_FROM_NAME?: string;
  RESEND_MAIL_API_KEY?: string;
}

export const createMailService = (source: MailEnv = process.env): EmailService => {
  const resendApiKey = source.RESEND_MAIL_API_KEY?.trim();
  const driverName = source.MAIL_DRIVER ?? (resendApiKey ? "resend" : "log");
  const fromEmail = source.MAIL_FROM_EMAIL ?? "noreply@example.com";
  const fromName = source.MAIL_FROM_NAME ?? "Radioso";

  if (driverName === "resend") {
    if (!resendApiKey) {
      throw new Error("RESEND_MAIL_API_KEY is required when MAIL_DRIVER is resend");
    }
    return new EmailService(new ResendEmailDriver(resendApiKey), { fromEmail, fromName });
  }
  if (driverName === "noop") {
    return new EmailService(new NoopEmailDriver(), { fromEmail, fromName });
  }
  if (driverName === "log") {
    return new EmailService(new LogEmailDriver(), { fromEmail, fromName });
  }
  throw new Error(`Unsupported MAIL_DRIVER "${driverName}"`);
};
