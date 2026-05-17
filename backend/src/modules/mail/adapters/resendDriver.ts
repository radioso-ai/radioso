import type { EmailDriver, EmailMessage } from "../emailService.js";

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
        reply_to: message.replyTo ?? undefined,
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
