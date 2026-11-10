import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { STAFF_PRIVILEGED_CHANGE_LOG_EVENT, STAFF_SIGN_IN_LOG_EVENT } from "./staffSecurityEvents.js";

/**
 * The staff console alerts find these lines by their `event` field, so the names logged here and
 * the names the Terraform filters match are one contract. Rewording a line's message leaves the
 * alerts working; renaming an event without this file failing would silence them.
 */
describe("the staff console log lines the Cloud alerts match", () => {
  it("are the events infra/terraform/monitoring.tf filters on", async () => {
    const monitoring = await readFile(new URL("../../../../../infra/terraform/monitoring.tf", import.meta.url), "utf8");

    expect(monitoring).toContain(`jsonPayload.event=\\"${STAFF_SIGN_IN_LOG_EVENT}\\" AND jsonPayload.outcome=\\"failure\\"`);
    expect(monitoring).toContain(`jsonPayload.event=\\"${STAFF_PRIVILEGED_CHANGE_LOG_EVENT}\\"`);
  });

  it("leaves out refusals anyone can produce without presenting an identity", async () => {
    const monitoring = await readFile(new URL("../../../../../infra/terraform/monitoring.tf", import.meta.url), "utf8");

    expect(monitoring).toContain(
      'NOT jsonPayload.reason=(\\"provider_error\\" OR \\"invalid_state\\" OR \\"oauth_exchange_failed\\")',
    );
  });
});
