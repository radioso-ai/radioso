import { describe, expect, it } from "vitest";

import {
  releaseAValidationPolicy,
  resolveInstallation,
  validateManifest,
  type AppManifest,
} from "@radioso/app-contract";

import {
  APP_ADMISSION_POLICY_VERSION,
  APP_INSTALLATION_PLAN_TTL_MS,
  AppsError,
  appManifestDigest,
  assertAppPlanApplicable,
  buildAppInstallationPlan,
} from "../../../src/modules/apps/public.js";
import { wordpressManifest } from "./support.js";

/**
 * The digest is what re-admission checks the stored manifest against, so a release
 * fixture computes it from the manifest it actually carries.
 */
const releaseOf = (manifest: AppManifest) => ({
  id: "11111111-1111-4111-8111-111111111111",
  appId: "ai.radioso.wordpress",
  version: "1.0.0",
  manifestDigest: appManifestDigest(manifest),
  manifest,
  state: "admitted",
  admissionPolicyVersion: APP_ADMISSION_POLICY_VERSION,
});

const release = () => releaseOf(wordpressManifest());

const now = new Date("2026-09-06T10:00:00.000Z");

const planInput = (overrides: Partial<Parameters<typeof buildAppInstallationPlan>[0]> = {}) => ({
  workspaceId: "22222222-2222-4222-8222-222222222222",
  release: release(),
  configuration: { site_url: "https://example.com", poll_interval_sec: 120 },
  boundConnectionSlotIds: ["webhook_secret"],
  now,
  ...overrides,
});

describe("app installation plan", () => {
  it("lists every grant the release would receive", () => {
    const { plan } = buildAppInstallationPlan(planInput());

    expect(plan.grants).toEqual([
      { kind: "collection", key: "sync_state" },
      { kind: "contribution", key: "content_poll" },
      { kind: "contribution", key: "content_push" },
      { kind: "contribution", key: "site_content" },
      { kind: "destination", key: "site" },
      { kind: "permission", key: "documents.delete" },
      { kind: "permission", key: "documents.ingest" },
      { kind: "permission", key: "egress.fetch" },
      { kind: "permission", key: "storage.read" },
      { kind: "permission", key: "storage.write" },
    ]);
  });

  it("resolves a configuration-bound destination host and applies declared defaults", () => {
    const { plan } = buildAppInstallationPlan(planInput());
    const postTypes = wordpressManifest().configuration.fields.find((field) => field.key === "post_types");
    const declaredDefault = postTypes && "default" in postTypes ? postTypes.default : undefined;

    expect(plan.configuration).toEqual({
      site_url: "https://example.com",
      post_types: declaredDefault,
      poll_interval_sec: 120,
    });
    expect(plan.destinations).toEqual([
      {
        id: "site",
        host: "example.com",
        protocols: ["https", "http"],
        credentials: { slotId: "site_credentials", mode: "http_basic", required: false },
      },
    ]);
  });

  it("marks a slot a required contribution needs as required, and reports an unbound one", () => {
    const { plan } = buildAppInstallationPlan(planInput({ boundConnectionSlotIds: [] }));

    expect(plan.connectionSlots).toEqual([
      { slotId: "site_credentials", kind: "secret_fields", required: true, bound: false },
      { slotId: "webhook_secret", kind: "generated_secret", required: true, bound: false },
    ]);
    expect(plan.unresolvedRequirements).toContainEqual(
      expect.objectContaining({ code: "connection_unbound", path: "connections.slots.webhook_secret" }),
    );
  });

  // One release, two installations: a site that pushes needs no credentials, and a site
  // that is polled does. Configuration decides which, so the plan has to ask for exactly
  // what this installation will run. Readiness here comes from a fully resolved
  // configuration (`resolveConfiguration` succeeded), which is the only map
  // `installationReadiness` is ever handed.
  it("requires only the slots the configuration actually turns on", () => {
    const pushOnly = buildAppInstallationPlan(planInput({
      configuration: { site_url: "https://example.com", poll_interval_sec: 0 },
      boundConnectionSlotIds: [],
    })).plan;

    expect(pushOnly.contributions).toContainEqual(
      expect.objectContaining({ id: "content_poll", active: false }),
    );
    // content_push is a `required` contribution, so its webhook_secret slot is required
    // regardless of the poll schedule; site_credentials is not, because polling is off.
    expect(pushOnly.connectionSlots).toEqual([
      { slotId: "site_credentials", kind: "secret_fields", required: false, bound: false },
      { slotId: "webhook_secret", kind: "generated_secret", required: true, bound: false },
    ]);
    expect(pushOnly.unresolvedRequirements.map((requirement) => requirement.path))
      .not.toContain("connections.slots.site_credentials");

    const polling = buildAppInstallationPlan(planInput({
      configuration: { site_url: "https://example.com", poll_interval_sec: 300 },
      boundConnectionSlotIds: [],
    })).plan;

    expect(polling.contributions).toContainEqual(
      expect.objectContaining({ id: "content_poll", active: true }),
    );
    // Polling is on, so both slots are required: site_credentials for the poll and
    // webhook_secret for the always-required content_push.
    expect(polling.connectionSlots).toEqual([
      { slotId: "site_credentials", kind: "secret_fields", required: true, bound: false },
      { slotId: "webhook_secret", kind: "generated_secret", required: true, bound: false },
    ]);
    expect(polling.unresolvedRequirements).toContainEqual(
      expect.objectContaining({ code: "connection_unbound", path: "connections.slots.site_credentials" }),
    );
  });

  it("reports an unresolved configuration-bound destination rather than inventing a host", () => {
    const { plan } = buildAppInstallationPlan(planInput({ configuration: { poll_interval_sec: 120 } }));

    expect(plan.destinations).toEqual([
      {
        id: "site",
        host: null,
        protocols: ["https", "http"],
        credentials: { slotId: "site_credentials", mode: "http_basic", required: false },
      },
    ]);
    expect(plan.unresolvedRequirements).toContainEqual(
      expect.objectContaining({ code: "configuration_required", path: "configuration.site_url" }),
    );
    expect(plan.unresolvedRequirements).toContainEqual(
      expect.objectContaining({ code: "destination_host_unresolved", path: "destinations.site" }),
    );
  });

  it("refuses a configuration value the manifest schema does not allow", () => {
    expect(() => buildAppInstallationPlan(planInput({ configuration: { site_url: "not-a-url" } })))
      .toThrow(expect.objectContaining({ reason: "invalid_configuration" }));
    expect(() => buildAppInstallationPlan(planInput({ configuration: { site_url: "https://a.example", poll_interval_sec: "soon" } })))
      .toThrow(expect.objectContaining({ reason: "invalid_configuration" }));
    // The schedule this field drives runs 60 to 86400 seconds; 30 is neither in range nor
    // the 0 sentinel that leaves it off.
    expect(() => buildAppInstallationPlan(planInput({ configuration: { site_url: "https://a.example", poll_interval_sec: 30 } })))
      .toThrow(expect.objectContaining({ reason: "invalid_configuration" }));
  });

  // A configuration still missing a required field (here, site_url) is a draft: there is
  // no authoritative answer yet to which contributions are active or which slots they
  // need, so the plan reports readiness as undetermined rather than guessing from a
  // hand-built partial map. `unresolvedRequirements` — not the contributions/slots
  // lists — is what tells the operator the plan is not ready.
  it("reports readiness as undetermined while required configuration is still missing", () => {
    const { plan } = buildAppInstallationPlan(planInput({ configuration: { poll_interval_sec: 300 } }));

    expect(plan.unresolvedRequirements).toContainEqual(
      expect.objectContaining({ code: "configuration_required", path: "configuration.site_url" }),
    );
    expect(plan.contributions.every((contribution) => contribution.active === false)).toBe(true);
    expect(plan.connectionSlots.every((slot) => slot.required === false)).toBe(true);
  });

  it("is deterministic: the same inputs in any order produce the same checksum and expiry", () => {
    const first = buildAppInstallationPlan(planInput());
    const second = buildAppInstallationPlan(planInput({
      configuration: { poll_interval_sec: 120, site_url: "https://example.com" },
    }));

    expect(second.checksum).toBe(first.checksum);
    expect(first.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.expiresAt.getTime()).toBe(now.getTime() + APP_INSTALLATION_PLAN_TTL_MS);
  });

  it("changes the checksum when anything the operator approved changes", () => {
    const baseline = buildAppInstallationPlan(planInput()).checksum;

    expect(buildAppInstallationPlan(planInput({ boundConnectionSlotIds: [] })).checksum).not.toBe(baseline);
    expect(buildAppInstallationPlan(planInput({
      configuration: { site_url: "https://other.example", poll_interval_sec: 120 },
    })).checksum).not.toBe(baseline);
  });

  // A connection field submitted as configuration is either a mistake or a secret in the
  // wrong box. Refusing says so; silently dropping it would leave the operator believing
  // they had supplied a credential.
  it("refuses a secret submitted as a configuration value", () => {
    expect(() => buildAppInstallationPlan(planInput({
      configuration: { site_url: "https://example.com", poll_interval_sec: 120, wp_application_password: "hunter2" },
    }))).toThrow(expect.objectContaining({ reason: "invalid_configuration" }));
  });

  // The persisted `manifest` field is `AppManifest`, not `AdmittedManifest`: nothing
  // stops a stored row from drifting away from what the release was admitted under. The
  // plan builder re-admits it through `admittedManifestOf` rather than trust the cast a
  // repository takes on read, so corruption here is a typed refusal, not a crash.
  it("refuses to build a plan when the stored release manifest no longer matches its recorded digest", () => {
    const { name: _name, ...appWithoutName } = wordpressManifest().app;
    const tamperedRelease = { ...release(), manifest: { ...wordpressManifest(), app: appWithoutName } as AppManifest };

    expect(() => buildAppInstallationPlan(planInput({ release: tamperedRelease })))
      .toThrow(expect.objectContaining({
        reason: "release_not_admitted",
        details: { cause: "manifest_digest_mismatch" },
      }));
  });

  it("binds the admission judgement the approval was taken against", () => {
    const { plan } = buildAppInstallationPlan(planInput());

    expect(plan.admissionPolicyVersion).toBe(APP_ADMISSION_POLICY_VERSION);
    expect(plan.releaseState).toBe("admitted");
  });

  /**
   * Readiness is the contract's answer and the plan consumes it unchanged. The contract
   * already accounts for destination credentials — it refuses a manifest whose required
   * credentials are not declared by the contribution that can reach them — so recomputing
   * them here could only ever over-require a slot the operator does not need.
   */
  it.each([
    { site_url: "https://example.com", poll_interval_sec: 0 },
    { site_url: "https://example.com", poll_interval_sec: 300 },
  ])("requires exactly the slots the contract's own readiness names", (configuration) => {
    const manifest = validateManifest(wordpressManifest(), releaseAValidationPolicy);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const resolved = resolveInstallation(manifest.manifest, configuration);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const { plan } = buildAppInstallationPlan(planInput({ configuration, boundConnectionSlotIds: [] }));

    expect(plan.connectionSlots.filter((slot) => slot.required).map((slot) => slot.slotId).sort())
      .toEqual([...resolved.readiness.requiredConnectionSlots].sort());
  });
});

describe("app plan applicability", () => {
  const applicable = {
    plan: { checksum: "sha256:abc", expiresAt: new Date(now.getTime() + 60_000), consumedAt: null },
    submittedChecksum: "sha256:abc",
    expectedInstallationVersion: null,
    currentInstallationVersion: null,
    now,
  };

  it("accepts a fresh, unconsumed plan whose checksum matches", () => {
    expect(() => assertAppPlanApplicable(applicable)).not.toThrow();
  });

  it("rejects a mismatched checksum as a stale plan", () => {
    try {
      assertAppPlanApplicable({ ...applicable, submittedChecksum: "sha256:other" });
      expect.unreachable("expected a stale plan");
    } catch (error) {
      expect(error).toBeInstanceOf(AppsError);
      expect(error).toMatchObject({ reason: "plan_stale", details: { cause: "checksum_mismatch" } });
    }
  });

  it("rejects an expired plan, a consumed plan, and a drifted installation version", () => {
    expect(() => assertAppPlanApplicable({ ...applicable, now: new Date(now.getTime() + 120_000) }))
      .toThrow(expect.objectContaining({ reason: "plan_stale", details: { cause: "expired" } }));
    expect(() => assertAppPlanApplicable({ ...applicable, plan: { ...applicable.plan, consumedAt: now } }))
      .toThrow(expect.objectContaining({ reason: "plan_stale", details: { cause: "consumed" } }));
    expect(() => assertAppPlanApplicable({
      ...applicable,
      expectedInstallationVersion: 1,
      currentInstallationVersion: 2,
    })).toThrow(expect.objectContaining({ reason: "plan_stale", details: { cause: "version_mismatch" } }));
  });
});
