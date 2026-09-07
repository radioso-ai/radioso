import { describe, expect, it } from "vitest";

import {
  appConfigurationSchema,
  configurationFieldSchema,
  configurationFieldTypes,
  configurationValuesSchema,
  MAX_CONFIGURATION_ENTRIES,
  MAX_CONFIGURATION_VALUE_LENGTH,
} from "../src/index.js";

const textField = {
  key: "post_types",
  type: "text",
  label: "Post types",
  required: false,
  default: "page,post",
};

describe("configuration fields", () => {
  it("offers exactly the bounded field vocabulary", () => {
    expect([...configurationFieldTypes]).toEqual([
      "text",
      "number",
      "boolean",
      "select",
      "url",
      "connection_slot",
    ]);
  });

  it("accepts a text field with a default", () => {
    expect(configurationFieldSchema.parse(textField)).toMatchObject({ key: "post_types", type: "text" });
  });

  it("rejects a field type outside the vocabulary", () => {
    expect(configurationFieldSchema.safeParse({ ...textField, type: "secret" }).success).toBe(false);
    expect(configurationFieldSchema.safeParse({ ...textField, type: "password" }).success).toBe(false);
  });

  it("type-checks a default against the field's own type", () => {
    expect(configurationFieldSchema.safeParse({ ...textField, type: "number", default: "daily" }).success).toBe(
      false,
    );
    expect(configurationFieldSchema.safeParse({ ...textField, type: "boolean", default: "yes" }).success).toBe(
      false,
    );
    expect(configurationFieldSchema.safeParse({ ...textField, default: 5 }).success).toBe(false);
    expect(
      configurationFieldSchema.parse({ ...textField, type: "number", default: 0, min: 0 }),
    ).toMatchObject({ type: "number", default: 0 });
    expect(
      configurationFieldSchema.parse({ ...textField, type: "boolean", default: false }),
    ).toMatchObject({ type: "boolean", default: false });
  });

  it("keeps a property a field type cannot mean out of it", () => {
    expect(configurationFieldSchema.safeParse({ ...textField, min: 1 }).success).toBe(false);
    expect(
      configurationFieldSchema.safeParse({ ...textField, options: [{ value: "post", label: "Posts" }] }).success,
    ).toBe(false);
    expect(
      configurationFieldSchema.safeParse({ ...textField, connectionSlot: "site_credentials" }).success,
    ).toBe(false);
    expect(configurationFieldSchema.safeParse({ ...textField, unknownKey: "x" }).success).toBe(false);
  });

  it("rejects a number field whose ceiling is below its floor", () => {
    expect(
      configurationFieldSchema.safeParse({ ...textField, type: "number", default: undefined, min: 10, max: 5 })
        .success,
    ).toBe(false);
  });

  it("requires a select field to declare its options and default among them", () => {
    const withoutOptions = configurationFieldSchema.safeParse({ ...textField, type: "select" });
    expect(withoutOptions.success).toBe(false);

    expect(
      configurationFieldSchema.safeParse({
        ...textField,
        type: "select",
        default: "video",
        options: [{ value: "post", label: "Posts" }],
      }).success,
    ).toBe(false);

    expect(
      configurationFieldSchema.safeParse({
        ...textField,
        type: "select",
        default: "post",
        options: [{ value: "post", label: "Posts" }],
      }).success,
    ).toBe(true);
  });

  it("requires a connection_slot field to name the slot it binds and to carry no value", () => {
    expect(
      configurationFieldSchema.safeParse({ key: "creds", type: "connection_slot", label: "Credentials" }).success,
    ).toBe(false);
    expect(
      configurationFieldSchema.safeParse({
        key: "creds",
        type: "connection_slot",
        label: "Credentials",
        connectionSlot: "site_credentials",
        default: "hunter2",
      }).success,
    ).toBe(false);
    expect(
      configurationFieldSchema.parse({
        key: "creds",
        type: "connection_slot",
        label: "Credentials",
        connectionSlot: "site_credentials",
      }),
    ).toMatchObject({ type: "connection_slot", connectionSlot: "site_credentials" });
  });

  it("keeps a requiredness flag off a connection_slot field, where nothing could read it", () => {
    expect(
      configurationFieldSchema.safeParse({
        key: "creds",
        type: "connection_slot",
        label: "Credentials",
        connectionSlot: "site_credentials",
        required: true,
      }).success,
    ).toBe(false);
  });

  it("requires a url field's default to be a URL", () => {
    expect(
      configurationFieldSchema.safeParse({ ...textField, type: "url", default: "not a URL" }).success,
    ).toBe(false);
    expect(
      configurationFieldSchema.parse({ ...textField, type: "url", default: "https://example.com" }),
    ).toMatchObject({ type: "url", default: "https://example.com" });
  });

  it("requires a number field's default to satisfy its own bounds", () => {
    expect(
      configurationFieldSchema.safeParse({ ...textField, type: "number", default: 5, min: 10 }).success,
    ).toBe(false);
    expect(
      configurationFieldSchema.safeParse({ ...textField, type: "number", default: 50, max: 10 }).success,
    ).toBe(false);
    expect(
      configurationFieldSchema.parse({ ...textField, type: "number", default: 10, min: 0, max: 60 }),
    ).toMatchObject({ type: "number", default: 10 });
  });

  it("rejects two select options that resolve to the same value", () => {
    expect(
      configurationFieldSchema.safeParse({
        ...textField,
        type: "select",
        options: [
          { value: "post", label: "Posts" },
          { value: "post", label: "Articles" },
        ],
      }).success,
    ).toBe(false);
  });

  it("defaults an omitted configuration block to no fields", () => {
    expect(appConfigurationSchema.parse({})).toEqual({ fields: [] });
  });
});

describe("configuration values", () => {
  it("carries one scalar per declared key", () => {
    expect(
      configurationValuesSchema.parse({ site_url: "https://example.com", poll_interval_sec: 0, verbose: true }),
    ).toMatchObject({ poll_interval_sec: 0, verbose: true });
  });

  it("refuses a key that is not a configuration key, and a value that is not a scalar", () => {
    expect(configurationValuesSchema.safeParse({ "Post Types": "page" }).success).toBe(false);
    expect(configurationValuesSchema.safeParse({ post_types: ["page"] }).success).toBe(false);
    expect(configurationValuesSchema.safeParse({ post_types: null }).success).toBe(false);
  });

  it("bounds one value and the whole map", () => {
    expect(
      configurationValuesSchema.safeParse({ post_types: "x".repeat(MAX_CONFIGURATION_VALUE_LENGTH) }).success,
    ).toBe(true);
    expect(
      configurationValuesSchema.safeParse({ post_types: "x".repeat(MAX_CONFIGURATION_VALUE_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(
      configurationValuesSchema.safeParse(
        Object.fromEntries(
          Array.from({ length: MAX_CONFIGURATION_ENTRIES + 1 }, (_, index) => [`field_${index}`, "v"]),
        ),
      ).success,
    ).toBe(false);
  });

  it("refuses a hundred-thousand entry map on breadth alone, before it reads an entry", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 100_000 }, (_, index) => [`field_${index}`, "x".repeat(64)]),
    );
    const parsed = configurationValuesSchema.safeParse(wide);
    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toEqual([
      `At most ${MAX_CONFIGURATION_ENTRIES} configuration values`,
    ]);
  });

  it("refuses a map whose entries are inherited rather than its own", () => {
    const inherited = Object.assign(Object.create({ inherited_key: "value" }) as object, {
      post_types: "page",
    });
    const parsed = configurationValuesSchema.safeParse(inherited);
    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toEqual([
      "A map is a plain JSON object carrying its own keys only",
    ]);
  });

  it("refuses a value space that is not a map at all", () => {
    expect(configurationValuesSchema.safeParse(["page"]).success).toBe(false);
    expect(configurationValuesSchema.safeParse("post_types=page").success).toBe(false);
    expect(configurationValuesSchema.safeParse(null).success).toBe(false);
  });
});
