import { describe, expect, it } from "vitest";

import { OauthClientError } from "../../../src/modules/integrationOauth/public.js";
import { normalizeSlackOauthTokenResponse } from "../../../src/modules/slack/oauth/slackProvider.js";

describe("provider token response normalizers", () => {
  it("normalizes Slack oauth.v2.access envelopes into stored OAuth tokens and install metadata", () => {
    const normalized = normalizeSlackOauthTokenResponse({
      ok: true,
      access_token: "xoxb-token",
      token_type: "bot",
      scope: "app_mentions:read,chat:write,im:history,im:read",
      bot_user_id: "U_BOT",
      team: { id: "T123", name: "Acme" },
      authed_user: { id: "U_ADMIN" },
    });

    expect(normalized).toEqual({
      tokens: {
        accessToken: "xoxb-token",
        tokenType: "bot",
        scope: "app_mentions:read chat:write im:history im:read",
      },
      providerAccountId: "T123",
      metadata: {
        teamId: "T123",
        teamName: "Acme",
        botUserId: "U_BOT",
        authedUserId: "U_ADMIN",
      },
    });
  });

  it("turns Slack ok:false responses into typed OAuth client errors without leaking token data", () => {
    expect(() =>
      normalizeSlackOauthTokenResponse({
        ok: false,
        error: "invalid_code",
        access_token: "xoxb-should-not-leak",
      }),
    ).toThrowError(new OauthClientError("invalid_token_response", "Slack OAuth token response was not ok: invalid_code"));
  });
});
