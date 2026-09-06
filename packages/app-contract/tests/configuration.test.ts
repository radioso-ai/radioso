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
  default: "post,page",
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

  it("requires a select field to declare its options", () => {
    const withoutOptions = configurationFieldSchema.safeParse({ ...textField, type: "select" });
    expect(withoutOptions.success).toBe(false);

    const withOptions = configurationFieldSchema.safeParse({
      ...textField,
      type: "select",
      options: [{ value: "post", label: "Posts" }],
    });
    expect(withOptions.success).toBe(true);
  });

  it("requires a connection_slot field to name the slot it binds", () => {
    expect(configurationFieldSchema.safeParse({ ...textField, type: "connection_slot" }).success).toBe(false);
    expect(
      configurationFieldSchema.safeParse({
        ...textField,
        type: "connection_slot",
        connectionSlot: "site_credentials",
      }).success,
    ).toBe(true);
  });

  it("defaults an omitted configuration block to no fields", () => {
    expect(appConfigurationSchema.parse({})).toEqual({ fields: [] });
  });
});
