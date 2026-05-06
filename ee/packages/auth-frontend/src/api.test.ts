import { afterEach, describe, expect, it, vi } from "vitest";

import { enterpriseAuthApi } from "./api.js";

describe("enterprise auth frontend api", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests password reset through the Enterprise auth namespace", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ accepted: true }), {
      headers: {
        "Content-Type": "application/json",
      },
      status: 202,
    }));

    await enterpriseAuthApi.requestPasswordReset({ email: "ada@example.com" });

    expect(fetchMock).toHaveBeenCalledWith("/backend/api/v1/ee/auth/password-reset/request", expect.objectContaining({
      body: JSON.stringify({ email: "ada@example.com" }),
      credentials: "include",
      method: "POST",
    }));
  });

  it("requests email verification resend through the Enterprise auth namespace", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ accepted: true }), {
      headers: {
        "Content-Type": "application/json",
      },
      status: 202,
    }));

    await enterpriseAuthApi.resendEmailVerification({ email: "ada@example.com" });

    expect(fetchMock).toHaveBeenCalledWith("/backend/api/v1/ee/auth/email-verification/resend", expect.objectContaining({
      body: JSON.stringify({ email: "ada@example.com" }),
      credentials: "include",
      method: "POST",
    }));
  });
});
