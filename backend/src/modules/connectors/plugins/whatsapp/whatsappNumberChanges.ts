import { whatsAppNumberKey } from "../../../../shared/domain/channelPersonKey.js";
import type { ChannelPersonDataEraser } from "../../../../shared/domain/conversationDataErasure.js";
import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";

/** A sender's number change Meta reported on a signed webhook: the number they left, and the business number it came to. */
interface WhatsAppNumberChange {
  readonly previousNumber: string;
  readonly phoneNumberId: string | null;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * The `user_changed_number` system messages of a webhook body (Meta's format): each is sent from the
 * number the sender left. Every other system message is not one.
 */
export const extractNumberChanges = (payload: unknown): WhatsAppNumberChange[] => {
  if (!isObject(payload) || payload.object !== "whatsapp_business_account") return [];
  const changes: WhatsAppNumberChange[] = [];
  for (const entry of arrayOf(payload.entry)) {
    for (const change of isObject(entry) ? arrayOf(entry.changes) : []) {
      const value = isObject(change) ? change.value : undefined;
      if (!isObject(value)) continue;
      const phoneNumberId = isObject(value.metadata) && typeof value.metadata.phone_number_id === "string" ? value.metadata.phone_number_id : null;
      for (const message of arrayOf(value.messages)) {
        if (!isObject(message) || message.type !== "system" || !isObject(message.system)) continue;
        if (message.system.type === "user_changed_number" && typeof message.from === "string") {
          changes.push({ previousNumber: message.from, phoneNumberId });
        }
      }
    }
  }
  return changes;
};

type NumberChangeOutcome = "forgotten" | "unreadable" | "failed";

/**
 * Forgets the person values kept under a number its sender left (#1884), so whoever WhatsApp gives
 * the number next reads none of them. The values are another module's, erased through its port.
 * Counted by outcome; the number is never logged, counted or traced.
 */
export class WhatsAppNumberChanges {
  constructor(private readonly deps: {
    personValues: ChannelPersonDataEraser;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  }) {}

  async forget(input: { workspaceId: string; previousNumber: string }): Promise<void> {
    const number = whatsAppNumberKey(input.previousNumber);
    if (!number) {
      this.count("unreadable");
      return;
    }
    try {
      await this.deps.personValues.eraseChannelPersons({ workspaceId: input.workspaceId, keys: [{ kind: "whatsapp_contact", id: number }] });
    } catch (error) {
      this.count("failed");
      throw error;
    }
    this.count("forgotten");
  }

  private count(outcome: NumberChangeOutcome): void {
    this.deps.metrics?.incrementCounter("whatsapp_number_changes_total", {
      help: "WhatsApp senders who changed their number, by whether the old number's person values were forgotten",
      labels: { outcome },
    });
  }
}
