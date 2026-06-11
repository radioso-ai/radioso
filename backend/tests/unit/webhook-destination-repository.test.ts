import { describe, expect, it, vi } from "vitest";

import { WebhookDestinationRepository } from "../../src/db/repositories/webhookDestinationRepository.js";
import type { Database } from "../../src/shared/infra/database.js";

const mockDatabase = () => {
  const db = {
    query: vi.fn().mockResolvedValue([]),
    queryOptional: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn().mockResolvedValue(1),
    withTransaction: vi.fn(),
  };
  return db as unknown as Database & typeof db;
};

describe("WebhookDestinationRepository", () => {
  it("does not send malformed destination ids to UUID predicates", async () => {
    const db = mockDatabase();
    const repository = new WebhookDestinationRepository(db);

    await expect(repository.findByIdAndWorkspace("missing-destination", "workspace-1")).resolves.toBeNull();
    await expect(repository.update("missing-destination", "workspace-1", {
      name: "crm",
      url: "https://hooks.example.com",
    })).resolves.toBeNull();
    await expect(repository.updateSecret("missing-destination", "workspace-1", {
      secretCiphertext: "ciphertext",
      encryptionKeyId: "connector",
    })).resolves.toBeNull();
    await expect(repository.delete("missing-destination", "workspace-1")).resolves.toBe(false);

    expect(db.queryOptional).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("records the latest delivery outcome timestamp for a destination", async () => {
    const db = mockDatabase();
    const repository = new WebhookDestinationRepository(db);

    await repository.recordDeliveryOutcome("33333333-3333-4333-8333-333333333333", "workspace-1", "success");

    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining("last_delivery_status"),
      ["33333333-3333-4333-8333-333333333333", "workspace-1", "success"],
    );
  });
});
