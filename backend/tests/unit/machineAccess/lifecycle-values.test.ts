import { describe, expect, it } from "vitest";
import { MACHINE_ACCESS_LIMITS, minimumRole } from "../../../src/modules/machineAccess/domain.js";

describe("machine-access lifecycle rules", () => {
  it("caps credentials and keeps an admin ceiling bounded by a demoted role", () => {
    expect(MACHINE_ACCESS_LIMITS.maxActivePersonalCredentials).toBe(10);
    expect(MACHINE_ACCESS_LIMITS.maxActiveCredentialsPerServiceAccount).toBe(5);
    expect(minimumRole("admin", "member")).toBe("member");
  });
});
