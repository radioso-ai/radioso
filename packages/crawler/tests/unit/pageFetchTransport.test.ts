import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchText } from "../../src/transport/pageFetchTransport.js";

const certificateHostnameError = (subjectaltname: string): Error => {
  const cause = Object.assign(new Error("certificate hostname mismatch"), {
    code: "ERR_TLS_CERT_ALTNAME_INVALID",
    cert: { subjectaltname },
  });
  return new TypeError("fetch failed", { cause });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("page fetch transport", () => {
  it("retries an apex HTTPS URL on www when the presented certificate proves that host", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(certificateHostnameError("DNS:www.example.com"))
      .mockResolvedValueOnce(new Response("User-agent: *", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchText("https://example.com/robots.txt"))
      .resolves.toEqual({
        ok: true,
        status: 200,
        contentType: "text/plain",
        body: "User-agent: *",
      });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://www.example.com/robots.txt",
      expect.any(Object),
    );
  });

  it("does not retry on www unless the presented certificate proves that host", async () => {
    const error = certificateHostnameError("DNS:other.example.com");
    const fetchMock = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchText("https://example.com/robots.txt")).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("validates the certificate-proven fallback before sending the retry", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(certificateHostnameError("DNS:www.example.com"));
    const validateNavigationUrl = vi.fn((url: string) => {
      if (url.includes("www.example.com")) {
        throw new Error("Blocked fallback target");
      }
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchText("https://example.com/robots.txt", { validateNavigationUrl }))
      .rejects.toThrow("Blocked fallback target");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(validateNavigationUrl).toHaveBeenCalledWith("https://www.example.com/robots.txt");
  });
});
