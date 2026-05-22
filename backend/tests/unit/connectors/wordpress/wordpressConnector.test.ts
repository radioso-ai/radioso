import { describe, expect, it } from "vitest";

import { WordpressConnector } from "../../../../src/modules/connectors/plugins/wordpress/wordpressConnector.js";

describe("WordpressConnector.validateConfig", () => {
  const connector = new WordpressConnector();

  it("rejects a site URL without http(s) scheme", () => {
    const issues = connector.validateConfig({
      site_url: "example.com",
      auth_mode: "shared_secret",
      webhook_shared_secret: "x",
    });
    expect(issues.map((i) => i.key)).toContain("site_url");
  });

  it("requires username and application password when auth_mode is application_password", () => {
    const issues = connector.validateConfig({
      site_url: "https://example.com",
      auth_mode: "application_password",
      webhook_shared_secret: "x",
    });
    const keys = issues.map((i) => i.key);
    expect(keys).toContain("wp_username");
    expect(keys).toContain("wp_application_password");
  });

  it("accepts shared_secret auth without WordPress credentials", () => {
    const issues = connector.validateConfig({
      site_url: "https://example.com",
      auth_mode: "shared_secret",
      webhook_shared_secret: "x",
    });
    expect(issues).toEqual([]);
  });

  it("rejects a non-integer poll interval", () => {
    const issues = connector.validateConfig({
      site_url: "https://example.com",
      auth_mode: "shared_secret",
      webhook_shared_secret: "x",
      poll_interval_sec: "thirty",
    });
    expect(issues.map((i) => i.key)).toContain("poll_interval_sec");
  });

  it("accepts a zero poll interval (webhook-only mode)", () => {
    const issues = connector.validateConfig({
      site_url: "https://example.com",
      auth_mode: "shared_secret",
      webhook_shared_secret: "x",
      poll_interval_sec: "0",
    });
    expect(issues).toEqual([]);
  });
});

describe("WordpressConnector schema", () => {
  const connector = new WordpressConnector();
  const schema = connector.configSchema();
  const keys = schema.map((f) => f.key);

  it("declares all configuration fields the frontend will render", () => {
    expect(keys).toEqual([
      "site_url",
      "auth_mode",
      "wp_username",
      "wp_application_password",
      "webhook_shared_secret",
      "post_types",
      "poll_interval_sec",
    ]);
  });

  it("marks the webhook secret and application password as secret fields", () => {
    const secretKeys = schema.filter((f) => f.type === "secret").map((f) => f.key);
    expect(secretKeys).toContain("webhook_shared_secret");
    expect(secretKeys).toContain("wp_application_password");
  });

  it("uses site_url as the unique channel field so one site maps to one workspace", () => {
    expect(connector.uniqueChannelField()).toBe("site_url");
  });

  it("declares a workspace-scoped webhook path", () => {
    expect(connector.getWebhookPath()).toBe("/api/connectors/wordpress/:workspaceId/webhook");
  });
});
