import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  appManifestSchema,
  releaseAValidationPolicy,
  resolveInstallation,
  validateManifest,
  type AdmittedManifest,
  type AppManifest,
  type Destination,
  type EffectiveConfiguration,
} from "../src/index.js";

const fixturePath = fileURLToPath(new URL("../fixtures/reference/wordpress.manifest.json", import.meta.url));
const fixtureJson = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
const result = validateManifest(fixtureJson, releaseAValidationPolicy);
if (!result.ok) throw new Error("the reference WordPress manifest must validate");
const manifest: AdmittedManifest = result.manifest;

/**
 * `resolveInstallation` takes only what `validateManifest` admitted, so every
 * test that builds a manifest variant reaches it the same way a host does:
 * through admission, not by asserting a raw candidate past it.
 */
const admit = (candidate: AppManifest): AdmittedManifest => {
  const admitted = validateManifest(candidate, releaseAValidationPolicy);
  if (!admitted.ok) throw new Error(`expected the manifest to admit: ${JSON.stringify(admitted.issues)}`);
  return admitted.manifest;
};

const codesFor = (values: unknown, against: AdmittedManifest = manifest): string[] => {
  const resolved = resolveInstallation(against, values);
  return resolved.ok ? [] : resolved.issues.map((issue) => issue.code);
};

const configurationOf = (values: unknown): EffectiveConfiguration => {
  const resolved = resolveInstallation(manifest, values);
  if (!resolved.ok) throw new Error(`expected a resolvable installation: ${JSON.stringify(resolved.issues)}`);
  return resolved.configuration;
};

const readinessOf = (values: unknown, against: AdmittedManifest = manifest) => {
  const resolved = resolveInstallation(against, values);
  if (!resolved.ok) throw new Error(`expected a resolvable installation: ${JSON.stringify(resolved.issues)}`);
  return resolved.readiness;
};

const withDestination = (destination: Destination): AppManifest => ({
  ...manifest,
  destinations: [destination],
});

describe("resolveInstallation", () => {
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
    const resolved = resolveInstallation(manifest, { site_url: "https://example.com", [hostile]: "v" });
    const rendered = resolved.ok ? "" : JSON.stringify(resolved.issues);
    expect(rendered).toContain("configuration.1");
    expect(rendered).not.toContain(hostile);
  });

  it("addresses an undeclared key by position even when it is spelled like a field key", () => {
    const hostile = "customer_ssn_123456789";
    const resolved = resolveInstallation(manifest, { site_url: "https://example.com", [hostile]: "x" });
    const rendered = resolved.ok ? "" : JSON.stringify(resolved.issues);
    expect(resolved.ok ? [] : resolved.issues.map((issue) => issue.path)).toEqual(["configuration.1"]);
    expect(rendered).not.toContain(hostile);
  });

  it("stops collecting issues long before an oversized map becomes the answer", () => {
    const noisy = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`k${index}`, "v"]));
    const resolved = resolveInstallation(manifest, noisy);
    expect(resolved.ok).toBe(false);
    expect(resolved.ok ? 0 : resolved.issues.length).toBeLessThanOrEqual(32);
  });

  it("keeps a select value among its options and a slot field out of the value space", () => {
    const withSelect = admit({
      ...manifest,
      configuration: {
        fields: [
          ...manifest.configuration.fields,
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
            connectionSlot: "site_credentials",
          },
        ],
      },
    });
    expect(resolveInstallation(withSelect, { locale: "it", site_url: "https://example.com" }).ok).toBe(true);
    expect(
      codesFor({ locale: "de", site_url: "https://example.com", credentials: "hunter2" }, withSelect),
    ).toEqual(["connection_slot_has_no_value", "unknown_select_option"]);
  });
});

describe("a value a schedule reads", () => {
  it("runs only on a whole number of seconds inside the declared interval range", () => {
    expect(codesFor({ site_url: "https://example.com", poll_interval_sec: 30 })).toEqual([
      "schedule_value_out_of_range",
    ]);
    expect(codesFor({ site_url: "https://example.com", poll_interval_sec: 90.5 })).toEqual([
      "schedule_value_out_of_range",
    ]);
    expect(configurationOf({ site_url: "https://example.com", poll_interval_sec: 300 })).toMatchObject({
      poll_interval_sec: 300,
    });
    expect(configurationOf({ site_url: "https://example.com", poll_interval_sec: 60 })).toMatchObject({
      poll_interval_sec: 60,
    });
    expect(configurationOf({ site_url: "https://example.com", poll_interval_sec: 86_400 })).toMatchObject({
      poll_interval_sec: 86_400,
    });
  });

  it("accepts the sentinel that turns the schedule off, and nothing else below the floor", () => {
    expect(configurationOf({ site_url: "https://example.com", poll_interval_sec: 0 })).toMatchObject({
      poll_interval_sec: 0,
    });
    expect(codesFor({ site_url: "https://example.com", poll_interval_sec: 1 })).toEqual([
      "schedule_value_out_of_range",
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

  it("refuses a query or a fragment on a prefix every request is appended below", () => {
    expect(codesFor({ site_url: "https://example.com/wordpress?preview=1" })).toEqual([
      "url_carries_query_or_fragment",
    ]);
    expect(codesFor({ site_url: "https://example.com/wordpress#frag" })).toEqual([
      "url_carries_query_or_fragment",
    ]);
  });
});

describe("the readiness resolution answers with", () => {
  it("leaves a disabled poll inactive and asks only for the signing secret", () => {
    const readiness = readinessOf({ site_url: "https://example.com" });
    expect(readiness.activeContributionIds).toEqual(["site_content", "content_push"]);
    expect(readiness.inactiveContributionIds).toEqual(["content_poll"]);
    expect(readiness.requiredConnectionSlots).toEqual(["webhook_secret"]);
  });

  it("asks for site credentials once the operator picks an interval", () => {
    const readiness = readinessOf({ site_url: "https://example.com", poll_interval_sec: 300 });
    expect(readiness.activeContributionIds).toEqual(["site_content", "content_push", "content_poll"]);
    expect(readiness.inactiveContributionIds).toEqual([]);
    expect(readiness.requiredConnectionSlots).toEqual(["site_credentials", "webhook_secret"]);
  });

  it("names a slot once, however many active contributions require it", () => {
    const shared = admit({
      ...manifest,
      contributions: manifest.contributions.map((contribution) =>
        contribution.kind === "document_source"
          ? { ...contribution, requiredConnectionSlots: ["webhook_secret"] }
          : contribution,
      ),
    });
    expect(readinessOf({ site_url: "https://example.com" }, shared).requiredConnectionSlots).toEqual([
      "webhook_secret",
    ]);
  });
});

describe("the port a destination-bound address reaches", () => {
  const siteDestination: Destination = manifest.destinations[0];

  it("is the default port of the scheme when the destination declares no ports", () => {
    expect(configurationOf({ site_url: "https://example.com" })).toMatchObject({
      site_url: "https://example.com",
    });
    expect(configurationOf({ site_url: "https://example.com:443" })).toMatchObject({
      site_url: "https://example.com:443",
    });
    expect(configurationOf({ site_url: "http://example.com:80" })).toMatchObject({
      site_url: "http://example.com:80",
    });
    expect(codesFor({ site_url: "https://example.com:8443" })).toEqual(["url_port_not_declared"]);
  });

  it("is exactly what an explicit ports list declares, default or not", () => {
    const explicit = admit(withDestination({ ...siteDestination, ports: [8443] }));
    expect(codesFor({ site_url: "https://example.com:8443" }, explicit)).toEqual([]);
    expect(codesFor({ site_url: "https://example.com" }, explicit)).toEqual(["url_port_not_declared"]);
    expect(codesFor({ site_url: "https://example.com:443" }, explicit)).toEqual(["url_port_not_declared"]);
  });

  it("is checked once the scheme is one the destination declares", () => {
    expect(codesFor({ site_url: "ftp://example.com:21" })).toEqual(["url_protocol_not_declared"]);
  });
});

describe("resolveInstallation", () => {
  it("answers configuration and readiness in one call, so neither can be paired with another manifest", () => {
    const resolved = resolveInstallation(manifest, { site_url: "https://example.com" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.configuration).toMatchObject({ site_url: "https://example.com" });
    expect(resolved.readiness.inactiveContributionIds).toEqual(["content_poll"]);
  });

  it("freezes the configuration it returns, so an interval cannot be edited after the fact", () => {
    const configuration = configurationOf({ site_url: "https://example.com", poll_interval_sec: 300 });
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(() => {
      (configuration as unknown as Record<string, unknown>)["poll_interval_sec"] = 30;
    }).toThrow(TypeError);
    expect(configuration).toMatchObject({ poll_interval_sec: 300 });
  });

  it("keeps the brand out of reach, so a stored map cannot be spelled as a resolved one", () => {
    // @ts-expect-error the brand is a symbol this package does not export
    const forged: EffectiveConfiguration = { site_url: "https://example.com", poll_interval_sec: 30 };
    expect(forged).toMatchObject({ poll_interval_sec: 30 });
  });

  it("does not compile against a manifest that validateManifest has not admitted", () => {
    const raw: AppManifest = appManifestSchema.parse(fixtureJson);
    // @ts-expect-error resolveInstallation takes an AdmittedManifest, not a raw parsed AppManifest
    const resolved = resolveInstallation(raw, { site_url: "https://example.com" });
    expect(resolved.ok).toBe(true);
  });

  it("refuses a stored map carrying an accessor, without ever invoking it", () => {
    const getter = vi.fn(() => "https://example.com");
    const hostile = Object.defineProperty({}, "site_url", { get: getter, enumerable: true });
    expect(codesFor(hostile)).toEqual(["invalid_configuration_values"]);
    expect(getter).not.toHaveBeenCalled();
  });

  it("answers with an issue rather than a throw when Object.prototype carries an enumerable key", () => {
    Object.defineProperty(Object.prototype, "polluted_key", {
      value: "value",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    try {
      expect(codesFor({ site_url: "https://example.com" })).toEqual(["invalid_configuration_values"]);
    } finally {
      Reflect.deleteProperty(Object.prototype, "polluted_key");
    }
  });
});
