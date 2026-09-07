import { describe, expect, it } from "vitest";

import {
  appConfigurationSchema,
  configurationFieldSchema,
  configurationFieldTypes,
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
      configurationFieldSchema.safeParse({ key: "creds", type: "connection_slot", label: "Credentials", required: true })
        .success,
    ).toBe(false);
    expect(
      configurationFieldSchema.safeParse({
        key: "creds",
        type: "connection_slot",
        label: "Credentials",
        required: true,
        connectionSlot: "site_credentials",
        default: "hunter2",
      }).success,
    ).toBe(false);
    expect(
      configurationFieldSchema.parse({
        key: "creds",
        type: "connection_slot",
        label: "Credentials",
        required: true,
        connectionSlot: "site_credentials",
      }),
    ).toMatchObject({ type: "connection_slot", connectionSlot: "site_credentials" });
  });

  it("defaults an omitted configuration block to no fields", () => {
    expect(appConfigurationSchema.parse({})).toEqual({ fields: [] });
  });
});
