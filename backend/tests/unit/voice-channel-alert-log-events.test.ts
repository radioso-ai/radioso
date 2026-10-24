import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { VOICE_TURN_LOG_EVENT } from "../../src/modules/voiceChannel/domain.js";
import type { VoiceTurnRecord, VoiceTurnResult } from "../../src/modules/voiceChannel/services/voiceTurnRecord.js";

/**
 * The voice turn health alert counts the turn's one log line by its `event` and two of its fields,
 * so the names the service logs and the names the Terraform log metrics filter on are one
 * contract. The field names are checked against the turn record the line is built from.
 */
const TURN_LIMIT_FIELD = "turnLimitReached" satisfies keyof NonNullable<VoiceTurnRecord["policy"]>;
const RESULT_FIELD = "result" satisfies keyof VoiceTurnRecord;
const ABANDONED_RESULT = "abandoned" satisfies VoiceTurnResult;

describe("the voice turn log line the Cloud alert counts", () => {
  it("is the event and fields infra/terraform/monitoring.tf filters its voice log metrics on", async () => {
    const monitoring = await readFile(new URL("../../../infra/terraform/monitoring.tf", import.meta.url), "utf8");
    const event = `jsonPayload.event=\\"${VOICE_TURN_LOG_EVENT}\\"`;

    expect(monitoring).toContain(`${event} AND jsonPayload.${TURN_LIMIT_FIELD}=true`);
    expect(monitoring).toContain(`${event} AND jsonPayload.${RESULT_FIELD}=\\"${ABANDONED_RESULT}\\"`);
  });
});
