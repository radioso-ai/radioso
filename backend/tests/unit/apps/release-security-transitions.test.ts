import { describe, expect, it } from "vitest";

import { appReleaseStates, type AppReleaseState } from "../../../src/modules/apps/domain/records.js";
import { AppsError } from "../../../src/modules/apps/public.js";
import {
  APPS_TEST_PRINCIPAL as principal,
  createAppsHarness,
  type AppsHarness,
} from "./support.js";

const transition = (harness: AppsHarness, releaseId: string, state: AppReleaseState) =>
  harness.releaseAdmission.transitionSecurityState({
    releaseId,
    state: state as "admitted" | "deprecated" | "revoked" | "quarantined",
    ...principal,
    actorUserId: principal.userId,
    reason: "test",
  });

const seed = async (harness: AppsHarness, releaseId: string, state: AppReleaseState) => {
  const row = await harness.repositories.releases.findById(releaseId);
  harness.repositories.releases.rows.set(releaseId, { ...row!, state });
};

/**
 * Which security decisions a release may travel is a rule, not a caller's choice. Every
 * edge is named here — the ones that exist and, more importantly, the ones that do not,
 * because an unconstrained state column is what lets a revoked release come back into a
 * state that executes.
 */
describe("app release security transitions", () => {
  const legal: Array<[AppReleaseState, AppReleaseState]> = [
    ["admitted", "deprecated"],
    ["admitted", "revoked"],
    ["admitted", "quarantined"],
    ["deprecated", "revoked"],
    ["deprecated", "quarantined"],
    ["quarantined", "admitted"],
    ["quarantined", "deprecated"],
  ];

  it.each(legal)("moves a %s release to %s", async (from, to) => {
    const harness = await createAppsHarness();
    const releaseId = await harness.admitReference();
    await seed(harness, releaseId, from);

    const moved = await transition(harness, releaseId, to);

    expect(moved.state).toBe(to);
    const audited = harness.audit.record.mock.calls.map((call) => call[0] as { eventType: string });
    expect(audited.at(-1)?.eventType).toBe(`app.release.${to}`);
  });

  const targets: AppReleaseState[] = ["admitted", "deprecated", "revoked", "quarantined"];
  const illegal = appReleaseStates.flatMap((from) => targets
    .filter((to) => !legal.some(([legalFrom, legalTo]) => legalFrom === from && legalTo === to))
    .map((to): [AppReleaseState, AppReleaseState] => [from, to]));

  it.each(illegal)("refuses to move a %s release to %s", async (from, to) => {
    const harness = await createAppsHarness();
    const releaseId = await harness.admitReference();
    await seed(harness, releaseId, from);

    await expect(transition(harness, releaseId, to)).rejects.toMatchObject({
      reason: "invalid_release_transition",
    } satisfies Partial<AppsError>);
    expect((await harness.repositories.releases.findById(releaseId))!.state).toBe(from);
  });

  it("records admission time when a quarantine is lifted, and leaves it alone otherwise", async () => {
    const harness = await createAppsHarness();
    const releaseId = await harness.admitReference();
    const admitted = await harness.repositories.releases.findById(releaseId);
    expect(admitted!.admittedAt).toBeInstanceOf(Date);

    const deprecated = await transition(harness, releaseId, "deprecated");
    // Deprecating a release is not admitting it, so the recorded admission stands.
    expect(deprecated.admittedAt?.getTime()).toBe(admitted!.admittedAt?.getTime());

    await transition(harness, releaseId, "quarantined");
    const released = await transition(harness, releaseId, "admitted");
    expect(released.admittedAt!.getTime()).toBeGreaterThanOrEqual(admitted!.admittedAt!.getTime());
  });
});
