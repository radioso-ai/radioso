import { describe, expect, it, vi } from "vitest";

import { createOrGetWithRetries } from "../../src/db/repositories/agentBundleImportRepository.js";

describe("createOrGetWithRetries", () => {
  it("retries a conflict whose row became terminal, then creates a fresh active job", async () => {
    const insert = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("fresh-job");
    const findExisting = vi.fn().mockResolvedValue(null);

    await expect(createOrGetWithRetries(insert, findExisting)).resolves.toEqual({ status: "created", row: "fresh-job" });
    expect(insert).toHaveBeenCalledTimes(2);
    expect(findExisting).toHaveBeenCalledTimes(1);
  });

  it("fails clearly after three unresolved concurrent transitions", async () => {
    const insert = vi.fn().mockResolvedValue(null);
    const findExisting = vi.fn().mockResolvedValue(null);

    await expect(createOrGetWithRetries(insert, findExisting))
      .rejects.toMatchObject({ statusCode: 409, code: "agent_bundle_import_contended" });
    expect(insert).toHaveBeenCalledTimes(3);
    expect(findExisting).toHaveBeenCalledTimes(3);
  });
});
