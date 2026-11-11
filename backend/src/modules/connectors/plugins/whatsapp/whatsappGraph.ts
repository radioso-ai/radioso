/** The WhatsApp Cloud API every call of this connector goes through. */
export const WHATSAPP_GRAPH_BASE_URL = "https://graph.facebook.com/v21.0";

export class WhatsAppClientError extends Error {
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(message: string, statusCode: number, retryable: boolean) {
    super(message);
    this.name = "WhatsAppClientError";
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}
