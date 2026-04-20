import { describe, expect, it } from "vitest";

import { getEnv } from "../../src/app/config/env.js";

describe("document storage env configuration", () => {
  it("defaults to local filesystem storage for local runs", () => {
    const env = getEnv({
      NODE_ENV: "test",
      PORT: "8080",
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
    });

    expect(env.DOCUMENT_STORAGE_DRIVER).toBe("local");
    expect(env.DOCUMENT_STORAGE_LOCAL_PATH).toBe("../.context/document-storage");
    expect(env.DOCUMENT_STORAGE_BUCKET).toBeUndefined();
  });

  it("requires a bucket when gcs storage is selected", () => {
    expect(() => getEnv({
      NODE_ENV: "test",
      PORT: "8080",
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
      DOCUMENT_STORAGE_DRIVER: "gcs",
    })).toThrow(/DOCUMENT_STORAGE_BUCKET/);
  });
});
