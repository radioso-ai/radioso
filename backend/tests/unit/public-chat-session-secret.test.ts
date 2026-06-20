import { describe, expect, it } from "vitest";

import { getEnv } from "../../src/app/config/env.js";
import { resolvePublicChatSessionSecret } from "../../src/app/http/shared/publicChatSessionSecret.js";

describe("public chat session secret resolution", () => {
  it("uses the explicit public chat session secret first", () => {
    expect(resolvePublicChatSessionSecret({
      NODE_ENV: "production",
      PUBLIC_CHAT_SESSION_SECRET: "public-chat-session-secret",
      WEBSITE_EMBED_SECRET: "legacy-website-embed-secret",
      WORKSPACE_TOKEN_SECRET: "workspace-token-secret",
    })).toBe("public-chat-session-secret");
  });

  it("keeps legacy website embed secrets working for existing local env files", () => {
    const env = getEnv({
      NODE_ENV: "production",
      PORT: "8080",
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
      WEBSITE_EMBED_SECRET: "legacy-website-embed-secret",
    });

    expect(resolvePublicChatSessionSecret(env)).toBe("legacy-website-embed-secret");
  });

  it("uses the workspace token secret as a development-only fallback", () => {
    expect(resolvePublicChatSessionSecret({
      NODE_ENV: "development",
      WORKSPACE_TOKEN_SECRET: "workspace-token-secret",
    })).toBe("workspace-token-secret");
  });
});
