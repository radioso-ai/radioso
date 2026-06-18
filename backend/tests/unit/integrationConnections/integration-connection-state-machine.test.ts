import { describe, expect, it } from "vitest";

import {
  assertIntegrationConnectionStatusTransition,
  canTransitionIntegrationConnectionStatus,
} from "../../../src/modules/integrationConnections/stateMachine.js";
import type { IntegrationConnectionStatus } from "../../../src/modules/integrationConnections/domain.js";

describe("integration connection lifecycle state machine", () => {
  const allowed: Array<[IntegrationConnectionStatus, IntegrationConnectionStatus]> = [
    ["authorized", "disabled"],
    ["authorized", "needs_reauth"],
    ["authorized", "error"],
    ["needs_reauth", "authorized"],
    ["needs_reauth", "error"],
    ["disabled", "authorized"],
    ["disabled", "needs_reauth"],
    ["disabled", "error"],
    ["error", "error"],
    ["authorized", "authorized"],
  ];

  it("allows only the documented lifecycle transitions", () => {
    for (const [from, to] of allowed) {
      expect(canTransitionIntegrationConnectionStatus(from, to), `${from} -> ${to}`).toBe(true);
    }

    expect(canTransitionIntegrationConnectionStatus("needs_reauth", "disabled")).toBe(false);
    expect(canTransitionIntegrationConnectionStatus("error", "authorized")).toBe(false);
    expect(canTransitionIntegrationConnectionStatus("disabled", "disabled")).toBe(true);
  });

  it("throws a clear error when a transition is not allowed", () => {
    expect(() => assertIntegrationConnectionStatusTransition("needs_reauth", "disabled")).toThrow(
      "Invalid integration connection status transition: needs_reauth -> disabled",
    );
  });
});
