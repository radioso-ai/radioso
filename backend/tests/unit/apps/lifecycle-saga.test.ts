import { describe, expect, it } from "vitest";

import {
  appSagaCompensationPlan,
  appSagaSteps,
  assertAppInstallationTransition,
  canTransitionAppInstallation,
  remainingAppSagaSteps,
} from "../../../src/modules/apps/public.js";

describe("app installation state machine", () => {
  it("walks the installation path the architecture describes", () => {
    const path = ["planned", "provisioning", "staged", "testing", "ready", "active"] as const;
    for (let index = 0; index + 1 < path.length; index += 1) {
      expect(canTransitionAppInstallation(path[index], path[index + 1])).toBe(true);
    }
    expect(canTransitionAppInstallation("active", "disabled")).toBe(true);
    expect(canTransitionAppInstallation("disabled", "active")).toBe(true);
    expect(canTransitionAppInstallation("active", "removing")).toBe(true);
    expect(canTransitionAppInstallation("removing", "removed")).toBe(true);
  });

  it("lets every pre-removal state fail and refuses to resurrect a removed installation", () => {
    for (const state of ["planned", "provisioning", "staged", "testing", "ready", "active"] as const) {
      expect(canTransitionAppInstallation(state, "failed")).toBe(true);
    }
    expect(canTransitionAppInstallation("removed", "active")).toBe(false);
    expect(canTransitionAppInstallation("planned", "active")).toBe(false);
    expect(() => assertAppInstallationTransition("removed", "active"))
      .toThrow(expect.objectContaining({ reason: "invalid_transition" }));
  });
});

describe("app lifecycle saga", () => {
  it("orders the install steps and the state each one enters", () => {
    expect(appSagaSteps.install.map((step) => [step.id, step.enters])).toEqual([
      ["create_records", "planned"],
      ["persist_grants_and_connections", null],
      ["provision_runtime", "provisioning"],
      ["stage_contributions", "staged"],
      ["run_safe_tests", "testing"],
      ["mark_ready", "ready"],
      ["activate", "active"],
    ]);
  });

  it("revokes grants and marks connections for deletion before disposing data on removal", () => {
    const ids = appSagaSteps.remove.map((step) => step.id);

    expect(ids).toEqual([
      "revoke_grants",
      "mark_connections_for_deletion",
      "stop_runtime",
      "detach_contributions",
      "dispose_data",
      "mark_removed",
    ]);
    expect(ids.indexOf("revoke_grants")).toBeLessThan(ids.indexOf("dispose_data"));
    expect(ids.indexOf("mark_connections_for_deletion")).toBeLessThan(ids.indexOf("dispose_data"));
  });

  it("resumes from the durable cursor at every step", () => {
    expect(remainingAppSagaSteps("install", null).map((step) => step.id)).toEqual(
      appSagaSteps.install.map((step) => step.id),
    );
    for (const [index, step] of appSagaSteps.install.entries()) {
      expect(remainingAppSagaSteps("install", step.id).map((remaining) => remaining.id))
        .toEqual(appSagaSteps.install.slice(index + 1).map((remaining) => remaining.id));
    }
  });

  it("compensates completed steps in reverse and never re-runs a completed external test", () => {
    expect(appSagaCompensationPlan("install", "run_safe_tests").map((step) => step.id)).toEqual([
      "stage_contributions",
      "provision_runtime",
      "persist_grants_and_connections",
      "create_records",
    ]);
    expect(appSagaCompensationPlan("install", "create_records").map((step) => step.id)).toEqual([
      "create_records",
    ]);
    expect(appSagaCompensationPlan("install", null)).toEqual([]);
    expect(appSagaCompensationPlan("remove", "mark_removed")).toEqual([]);
  });
});
