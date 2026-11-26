import { describe, expect, it, vi } from "vitest";

import { WhatsAppNumberChanges } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappNumberChanges.js";
import type { ChannelPersonDataEraser } from "../../../../src/shared/domain/conversationDataErasure.js";

// An obviously fake number in the reserved 555-01xx range.
const OLD_NUMBER = "15550100101";

const harness = (erase: ChannelPersonDataEraser["eraseChannelPersons"] = async () => 2) => {
  const personValues = { owner: "context-variables", eraseChannelPersons: vi.fn(erase) };
  const metrics = { incrementCounter: vi.fn() };
  return { personValues, metrics, changes: new WhatsAppNumberChanges({ personValues, metrics }) };
};

const counted = (metrics: { incrementCounter: ReturnType<typeof vi.fn> }) =>
  metrics.incrementCounter.mock.calls.map(([name, options]) => [name, (options as { labels: Record<string, string> }).labels]);

describe("a sender who changed their WhatsApp number", () => {
  it("leaves no person values under the old number, and counts it without the number", async () => {
    const { personValues, metrics, changes } = harness();

    await changes.forget({ workspaceId: "workspace-1", previousNumber: OLD_NUMBER });

    expect(personValues.eraseChannelPersons).toHaveBeenCalledWith({ workspaceId: "workspace-1", keys: [{ kind: "whatsapp_contact", id: OLD_NUMBER }] });
    expect(counted(metrics)).toEqual([["whatsapp_number_changes_total", { outcome: "forgotten" }]]);
    expect(JSON.stringify(metrics.incrementCounter.mock.calls)).not.toContain(OLD_NUMBER);
  });

  it("forgets nothing for an old id that is not a number", async () => {
    const { personValues, metrics, changes } = harness();

    await changes.forget({ workspaceId: "workspace-1", previousNumber: "not-a-number" });

    expect(personValues.eraseChannelPersons).not.toHaveBeenCalled();
    expect(counted(metrics)).toEqual([["whatsapp_number_changes_total", { outcome: "unreadable" }]]);
  });

  it("counts a forget that failed, and fails", async () => {
    const { metrics, changes } = harness(async () => {
      throw new Error("database unavailable");
    });

    await expect(changes.forget({ workspaceId: "workspace-1", previousNumber: OLD_NUMBER })).rejects.toThrow("database unavailable");
    expect(counted(metrics)).toEqual([["whatsapp_number_changes_total", { outcome: "failed" }]]);
  });
});
