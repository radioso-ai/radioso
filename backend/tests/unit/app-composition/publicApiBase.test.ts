import { describe, expect, it } from "vitest";

import { publicApiBaseUrl } from "../../../src/app/composition/publicApiBase.js";

describe("publicApiBaseUrl", () => {
  it.each([
    [
      { CONNECTOR_PUBLIC_BASE_URL: "https://api.example.com/", APP_BASE_URL: "https://app.example.com", PORT: 3001 },
      "https://api.example.com",
    ],
    [
      { CONNECTOR_PUBLIC_BASE_URL: undefined, APP_BASE_URL: "https://app.example.com/", PORT: 3001 },
      "https://app.example.com/backend",
    ],
    [
      { CONNECTOR_PUBLIC_BASE_URL: undefined, APP_BASE_URL: undefined, PORT: 3001 },
      "http://localhost:3001",
    ],
  ] as const)("resolves the public API base for %o", (env, expected) => {
    expect(publicApiBaseUrl(env)).toBe(expected);
  });
});
