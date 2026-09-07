import { describe, expect, it } from "vitest";

import {
  appConnectionsSchema,
  connectionSlotKinds,
  connectionSlotSchema,
  releaseAValidationPolicy,
} from "../src/index.js";

const secretFieldsSlot = {
  id: "site_credentials",
  kind: "secret_fields",
  displayName: "WordPress credentials",
  fields: [
    { key: "wp_username", label: "Username", sensitive: false, required: true },
    { key: "wp_application_password", label: "Application password", sensitive: true, required: true },
  ],
};

const generatedSecretSlot = {
  id: "webhook_secret",
  kind: "generated_secret",
  displayName: "Webhook signing secret",
};

describe("connection slots", () => {
  it("declares the slot kind vocabulary", () => {
    expect([...connectionSlotKinds]).toEqual(["secret_fields", "generated_secret", "oauth2"]);
  });

  it("accepts a secret_fields slot with per-field sensitivity", () => {
    const parsed = connectionSlotSchema.parse(secretFieldsSlot);
    expect(parsed.kind).toBe("secret_fields");
  });

  it("rejects a secret_fields slot with no fields", () => {
    expect(connectionSlotSchema.safeParse({ ...secretFieldsSlot, fields: [] }).success).toBe(false);
  });

  it("accepts a generated_secret slot and gives it a byte length", () => {
    const parsed = connectionSlotSchema.parse(generatedSecretSlot);
    expect(parsed).toMatchObject({ kind: "generated_secret", byteLength: 32 });
  });

  it("parses an oauth2 slot that the Release A policy does not support", () => {
    const parsed = connectionSlotSchema.safeParse({
      id: "site_oauth",
      kind: "oauth2",
      displayName: "Site OAuth",
      authorizationUrl: "https://example.com/oauth/authorize",
      tokenUrl: "https://example.com/oauth/token",
      scopes: ["read"],
    });
    expect(parsed.success).toBe(true);
    expect(releaseAValidationPolicy.supportedConnectionKinds).not.toContain("oauth2");
  });

  it("rejects an unknown slot kind", () => {
    expect(connectionSlotSchema.safeParse({ ...generatedSecretSlot, kind: "api_key" }).success).toBe(false);
  });

  it("defaults an omitted connections block to no slots", () => {
    expect(appConnectionsSchema.parse({})).toEqual({ slots: [] });
  });
});
