import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  installationReadiness,
  releaseAValidationPolicy,
  resolveConfiguration,
  validateManifest,
  type AppManifest,
  type ConfigurationValues,
} from "../src/index.js";

const fixturePath = fileURLToPath(new URL("../fixtures/reference/wordpress.manifest.json", import.meta.url));
const result = validateManifest(JSON.parse(readFileSync(fixturePath, "utf8")) as unknown, releaseAValidationPolicy);
if (!result.ok) throw new Error("the reference WordPress manifest must validate");
const manifest: AppManifest = result.manifest;

const codesFor = (values: unknown): string[] => {
  const resolved = resolveConfiguration(manifest, values);
  return resolved.ok ? [] : resolved.issues.map((issue) => issue.code);
};

const configurationOf = (values: unknown): ConfigurationValues => {
  const resolved = resolveConfiguration(manifest, values);
  if (!resolved.ok) throw new Error(`expected a resolvable configuration: ${JSON.stringify(resolved.issues)}`);
  return resolved.configuration;
};

describe("resolveConfiguration", () => {
  it("materializes every declared default, so an App reads one shape however little was stored", () => {
    expect(configurationOf({ site_url: "https://example.com" })).toEqual({
      site_url: "https://example.com",
      post_types: "page,post",
      poll_interval_sec: 0,
    });
  });

  it("keeps a stored value over the default it replaces", () => {
    expect(configurationOf({ site_url: "https://example.com", poll_interval_sec: 300 })).toMatchObject({
      poll_interval_sec: 300,
    });
  });

  it("copies rather than returns the stored map", () => {
    const stored = { site_url: "https://example.com" };
    const configuration = configurationOf(stored);
    expect(configuration).not.toBe(stored);
    expect(Object.hasOwn(stored, "post_types")).toBe(false);
  });

  it("requires every required field and refuses every undeclared key", () => {
    expect(codesFor({ post_types: "page,post" })).toEqual(["missing_required_value"]);
    expect(codesFor({ site_url: "https://example.com", admin_token: "hunter2" })).toEqual([
      "unknown_configuration_key",
    ]);
  });

  it("holds a value to the type its field declares", () => {
    expect(codesFor({ site_url: "https://example.com", poll_interval_sec: "daily" })).toEqual([
      "invalid_value_type",
    ]);
    expect(codesFor({ site_url: "https://example.com", post_types: 5 })).toEqual(["invalid_value_type"]);
    expect(codesFor({ site_url: "example.com" })).toEqual(["invalid_url_value"]);
    expect(codesFor({ site_url: "https://example.com", poll_interval_sec: -1 })).toEqual([
      "value_out_of_range",
    ]);
    expect(codesFor({ site_url: "https://example.com", post_types: "x".repeat(4097) })).toEqual([
      "value_too_long",
    ]);
  });

  it("refuses anything that is not a plain value map, an inherited value space included", () => {
    expect(codesFor("site_url=https://example.com")).toEqual(["invalid_configuration_values"]);
    expect(codesFor([])).toEqual(["invalid_configuration_values"]);
    expect(codesFor(Object.create({ site_url: "https://example.com" }) as unknown)).toEqual([
      "invalid_configuration_values",
    ]);
  });

  it("bounds the stored map before it looks a single field up", () => {
    const wide = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`k${index}`, "v"]));
    expect(codesFor(wide)).toEqual(["too_many_configuration_entries"]);
    expect(codesFor({ site_url: "https://example.com", ["A".repeat(4096)]: "v" })).toEqual([
      "invalid_configuration_key",
    ]);
  });

  it("never repeats a key or a value back into a diagnostic", () => {
    const hostile = "!".repeat(2048);
    const resolved = resolveConfiguration(manifest, { site_url: "https://example.com", [hostile]: "v" });
    const rendered = resolved.ok ? "" : JSON.stringify(resolved.issues);
    expect(rendered).toContain("configuration.1");
    expect(rendered).not.toContain(hostile);
  });

  it("stops collecting issues long before an oversized map becomes the answer", () => {
    const noisy = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`k${index}`, "v"]));
    const resolved = resolveConfiguration(manifest, noisy);
    expect(resolved.ok).toBe(false);
    expect(resolved.ok ? 0 : resolved.issues.length).toBeLessThanOrEqual(32);
  });

  it("keeps a select value among its options and a slot field out of the value space", () => {
    const withSelect: AppManifest = {
      ...manifest,
      configuration: {
        fields: [
          {
            key: "locale",
            type: "select",
            label: "Locale",
            required: true,
            options: [
              { value: "en", label: "English" },
              { value: "it", label: "Italian" },
            ],
          },
          {
            key: "credentials",
            type: "connection_slot",
            label: "Credentials",
            required: false,
            connectionSlot: "site_credentials",
          },
        ],
      },
    };
    expect(resolveConfiguration(withSelect, { locale: "it" }).ok).toBe(true);
    const rejected = resolveConfiguration(withSelect, { locale: "de", credentials: "hunter2" });
    expect(rejected.ok ? [] : rejected.issues.map((issue) => issue.code)).toEqual([
      "connection_slot_has_no_value",
      "unknown_select_option",
    ]);
  });
});

describe("a URL field a destination is built from", () => {
  it("accepts a site installed below a path, which the broker treats as an origin prefix", () => {
    expect(configurationOf({ site_url: "https://example.com/wordpress" })).toMatchObject({
      site_url: "https://example.com/wordpress",
    });
  });

  it("holds the address to a scheme the destination declares", () => {
    expect(codesFor({ site_url: "ftp://example.com" })).toEqual(["url_protocol_not_declared"]);
    expect(configurationOf({ site_url: "http://example.com" })).toMatchObject({
      site_url: "http://example.com",
    });
  });

  it("refuses a credential smuggled into the address as userinfo", () => {
    expect(codesFor({ site_url: "https://admin:hunter2@example.com" })).toEqual(["url_carries_userinfo"]);
  });
});

describe("installationReadiness", () => {
  it("leaves a disabled poll inactive and asks only for the signing secret", () => {
    const readiness = installationReadiness(manifest, configurationOf({ site_url: "https://example.com" }));
    expect(readiness.activeContributionIds).toEqual(["site_content", "content_push"]);
    expect(readiness.inactiveContributionIds).toEqual(["content_poll"]);
    expect(readiness.requiredConnectionSlots).toEqual(["webhook_secret"]);
  });

  it("asks for site credentials once the operator picks an interval", () => {
    const readiness = installationReadiness(
      manifest,
      configurationOf({ site_url: "https://example.com", poll_interval_sec: 300 }),
    );
    expect(readiness.activeContributionIds).toEqual(["site_content", "content_push", "content_poll"]);
    expect(readiness.inactiveContributionIds).toEqual([]);
    expect(readiness.requiredConnectionSlots).toEqual(["site_credentials", "webhook_secret"]);
  });

  it("never drops a required contribution's slot, whatever the configuration says", () => {
    const alwaysRequired: AppManifest = {
      ...manifest,
      contributions: manifest.contributions.map((contribution) =>
        contribution.id === "content_poll" ? { ...contribution, availability: "required" } : contribution,
      ),
    };
    const readiness = installationReadiness(
      alwaysRequired,
      configurationOf({ site_url: "https://example.com", poll_interval_sec: 0 }),
    );
    expect(readiness.inactiveContributionIds).toEqual([]);
    expect(readiness.requiredConnectionSlots).toEqual(["site_credentials", "webhook_secret"]);
  });

  it("names a slot once, however many active contributions require it", () => {
    const shared: AppManifest = {
      ...manifest,
      contributions: manifest.contributions.map((contribution) =>
        contribution.kind === "document_source"
          ? { ...contribution, requiredConnectionSlots: ["webhook_secret"] }
          : contribution,
      ),
    };
    expect(
      installationReadiness(shared, configurationOf({ site_url: "https://example.com" }))
        .requiredConnectionSlots,
    ).toEqual(["webhook_secret"]);
  });
});
