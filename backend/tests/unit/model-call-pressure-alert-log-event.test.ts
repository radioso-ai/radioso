import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { MODEL_CALL_PRESSURE_LOG_EVENT } from "../../src/shared/infra/llm/modelCallGovernance.js";

/**
 * The model call pressure alert counts the backend's log line by its `event`, so the name the
 * governor logs and the name the Terraform log metric filters on are one contract.
 * model-call-governance.test.ts shows which lines carry it.
 */
describe("the model call pressure log line the Cloud alert counts", () => {
  it("is the event infra/terraform/monitoring.tf filters its log metric on", async () => {
    const monitoring = await readFile(new URL("../../../infra/terraform/monitoring.tf", import.meta.url), "utf8");

    expect(monitoring).toContain(`jsonPayload.event=\\"${MODEL_CALL_PRESSURE_LOG_EVENT}\\"`);
  });
});
