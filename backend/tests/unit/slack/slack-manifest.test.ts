import { describe, expect, it } from "vitest";

import { buildSlackManifest, requiredSlackEnvVars, slackBotScopes } from "../../../src/modules/slack/manifest/slackManifest.js";

describe("slack manifest", () => {
  it("renders OAuth and Events URLs from APP_BASE_URL with only bot scopes", () => {
    const manifest = buildSlackManifest("https://radioso.example.com/");

    expect(manifest.oauth_config.redirect_urls).toEqual([
      "https://radioso.example.com/api/v1/oauth/callback/slack",
    ]);
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      "https://radioso.example.com/api/connectors/slack/events",
    );
    expect(manifest.settings.interactivity).toEqual({
      is_enabled: true,
      request_url: "https://radioso.example.com/api/connectors/slack/interactivity",
    });
    expect(manifest.oauth_config.scopes.bot).toEqual(slackBotScopes);
    expect(manifest.oauth_config.scopes.bot).toEqual(expect.arrayContaining(["users:read", "users:read.email", "reactions:write"]));
    expect(manifest.oauth_config.scopes.bot).not.toContain("search:read");
    expect(manifest.oauth_config.scopes.bot).not.toContain("search.messages");
  });

  it("subscribes to channel and private-channel messages with the history scopes they need", () => {
    const manifest = buildSlackManifest("https://radioso.example.com");

    expect(manifest.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining(["app_mention", "message.im", "message.channels", "message.groups"]),
    );
    expect(manifest.oauth_config.scopes.bot).toEqual(expect.arrayContaining(["channels:history", "groups:history"]));
  });

  it("registers the app on Slack's agent surface with the scope and event that surface needs", () => {
    const manifest = buildSlackManifest("https://radioso.example.com");

    expect(manifest.features.agent_view.agent_description.length).toBeGreaterThan(0);
    expect(manifest.features.agent_view.agent_description.length).toBeLessThanOrEqual(300);
    expect(manifest.features.agent_view).not.toHaveProperty("suggested_prompts");
    expect(manifest.features.app_home).toEqual({
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
    expect(manifest.oauth_config.scopes.bot).toContain("assistant:write");
    expect(manifest.settings.event_subscriptions.bot_events).toContain("app_home_opened");
    expect(manifest.settings.event_subscriptions.bot_events).not.toContain("agent_session_stopped");
  });

  it("declares the required Slack operator env vars", () => {
    expect(requiredSlackEnvVars).toEqual([
      "SLACK_OAUTH_CLIENT_ID",
      "SLACK_OAUTH_CLIENT_SECRET",
      "SLACK_SIGNING_SECRET",
    ]);
  });
});
