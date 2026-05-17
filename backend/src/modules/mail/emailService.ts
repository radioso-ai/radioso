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
}

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
