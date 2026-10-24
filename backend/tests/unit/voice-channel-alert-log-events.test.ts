import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { VOICE_TURN_ABANDONED_LOG_EVENT, VOICE_TURN_LIMIT_LOG_EVENT } from "../../src/modules/voiceChannel/domain.js";

/**
 * The voice turn health alert counts the turn log lines by their `event` field, so the names the
 * service logs and the names the Terraform log metrics filter on are one contract.
 */
describe("the voice turn log events the Cloud alert counts", () => {
  it("are the events infra/terraform/monitoring.tf filters its voice log metrics on", async () => {
    const monitoring = await readFile(new URL("../../../infra/terraform/monitoring.tf", import.meta.url), "utf8");

    for (const event of [VOICE_TURN_LIMIT_LOG_EVENT, VOICE_TURN_ABANDONED_LOG_EVENT]) {
      expect(monitoring).toContain(`jsonPayload.event=\\"${event}\\"`);
    }
  });

  it("are two distinct names", () => {
    expect(VOICE_TURN_LIMIT_LOG_EVENT).not.toBe(VOICE_TURN_ABANDONED_LOG_EVENT);
  });
});
