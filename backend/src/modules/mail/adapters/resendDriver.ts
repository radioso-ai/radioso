import type { EmailDriver, EmailMessage } from "../emailService.js";

export class ResendEmailDeliveryError extends Error {
  constructor(
    readonly statusCode: number,
    readonly providerErrorName?: string,
  ) {
    super(`Resend email delivery failed with status ${statusCode}`);
    this.name = "ResendEmailDeliveryError";
  }
}

export class ResendEmailDriver implements EmailDriver {
  constructor(private readonly apiKey: string) {}

  async send(message: EmailMessage): Promise<void> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (message.idempotencyKey) {
      headers["Idempotency-Key"] = message.idempotencyKey;
    }
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email,
        to: message.to,
        reply_to: message.replyTo ?? undefined,
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });

    if (!response.ok) {
      const providerErrorName = await readProviderErrorName(response);
      throw new ResendEmailDeliveryError(response.status, providerErrorName);
    }
  }
}

const readProviderErrorName = async (response: Response): Promise<string | undefined> => {
  const detail = await response.text();
  if (!detail) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(detail) as unknown;
    if (parsed && typeof parsed === "object" && "name" in parsed && typeof parsed.name === "string") {
      return parsed.name;
    }
  } catch {
    return undefined;
  }
  return undefined;
};
