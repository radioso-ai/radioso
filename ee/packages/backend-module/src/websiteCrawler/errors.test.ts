import { describe, expect, it } from "vitest";

import {
  WebsiteCrawlerProviderError,
  WebsiteCrawlerUnavailableError,
  toSafeWebsiteCrawlerError,
} from "./errors.js";

describe("enterprise website crawler errors", () => {
  it("returns unavailable errors without provider secrets", () => {
    const error = new WebsiteCrawlerUnavailableError("Enterprise website crawler is not configured", {
      secret: "crawler-secret",
    });

    expect(error.statusCode).toBe(503);
    expect(error.code).toBe("service_unavailable");
    expect(toSafeWebsiteCrawlerError(error)).toEqual({
      code: "service_unavailable",
      message: "Enterprise website crawler is not configured",
    });
  });

  it("redacts provider failure details", () => {
    const error = new WebsiteCrawlerProviderError("Provider rejected apiKey=crawler-secret authorization=Bearer-secret key=plain-secret signature=signed-secret at https://user:pass@crawler.example https://abc123@crawler.example/path https://:pass@crawler.example/path", {
      provider: "custom-crawler",
      apiKey: "crawler-secret",
      key: "plain-secret",
      password: "crawler-secret",
      signature: "signed-secret",
      credential: "crawler-secret",
      sig: "signed-secret",
      status: 401,
      request: {
        authorization: "Bearer sk_live_abc123",
        apiKey: "sk_live_nested",
        key: "plain-secret",
        signature: "signed-secret",
        headers: [
          "token=crawler-secret",
          "authorization=Bearer-secret",
          "key=plain-secret",
          "signature=signed-secret",
        ],
      },
    });

    expect(toSafeWebsiteCrawlerError(error)).toEqual({
      code: "website_crawler_provider_failed",
      message: "Provider rejected [redacted] [redacted] [redacted] [redacted] at https://[redacted]@crawler.example https://[redacted]@crawler.example/path https://[redacted]@crawler.example/path",
      details: {
        provider: "custom-crawler",
        request: {
          headers: ["[redacted]", "[redacted]", "[redacted]", "[redacted]"],
        },
        status: 401,
      },
    });
  });
});
