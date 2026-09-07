import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  releaseAValidationPolicy,
  requiredConnectionSlotsFor,
  validateConfigurationValues,
  validateManifest,
  type AppManifest,
} from "../src/index.js";

const fixturePath = fileURLToPath(new URL("../fixtures/reference/wordpress.manifest.json", import.meta.url));
const result = validateManifest(JSON.parse(readFileSync(fixturePath, "utf8")) as unknown, releaseAValidationPolicy);
if (!result.ok) throw new Error("the reference WordPress manifest must validate");
const manifest: AppManifest = result.manifest;

const codesFor = (values: unknown): string[] => {
  const validated = validateConfigurationValues(manifest, values);
  return validated.ok ? [] : validated.issues.map((issue) => issue.code);
};

describe("validateConfigurationValues", () => {
  it("returns the values an installation may hand an App", () => {
    const validated = validateConfigurationValues(manifest, {
      site_url: "https://example.com",
      post_types: "page,post,product",
      poll_interval_sec: 0,
    });
    expect(validated.ok ? validated.values : validated.issues).toEqual({
      site_url: "https://example.com",
      post_types: "page,post,product",
      poll_interval_sec: 0,
    });
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

  it("refuses anything that is not a value map at all", () => {
    expect(codesFor("site_url=https://example.com")).toEqual(["invalid_configuration_values"]);
    expect(codesFor([])).toEqual(["invalid_configuration_values"]);
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
    expect(validateConfigurationValues(withSelect, { locale: "it" }).ok).toBe(true);
    const rejected = validateConfigurationValues(withSelect, { locale: "de", credentials: "hunter2" });
    expect(rejected.ok ? [] : rejected.issues.map((issue) => issue.code)).toEqual([
      "unknown_select_option",
      "connection_slot_has_no_value",
    ]);
  });
});

describe("requiredConnectionSlotsFor", () => {
  it("asks for nothing when the installation only receives pushes it cannot verify yet", () => {
    expect(requiredConnectionSlotsFor(manifest, ["site_content"])).toEqual([]);
  });

  it("asks for the signing secret a push-only installation needs, and no site credentials", () => {
    expect(requiredConnectionSlotsFor(manifest, ["site_content", "content_push"])).toEqual([
      "webhook_secret",
    ]);
  });

  it("asks for site credentials only once polling is turned on", () => {
    expect(requiredConnectionSlotsFor(manifest, ["site_content", "content_push", "content_poll"])).toEqual([
      "webhook_secret",
      "site_credentials",
    ]);
  });

  it("names a slot once, however many active contributions require it", () => {
    expect(requiredConnectionSlotsFor(manifest, ["content_poll", "content_poll"])).toEqual([
      "site_credentials",
    ]);
  });
});
