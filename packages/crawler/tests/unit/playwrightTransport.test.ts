import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockTransport = {
  fetchPageWithScreenshot: typeof import("../../src/transport/playwright.js").fetchPageWithScreenshot;
  head: ReturnType<typeof vi.fn>;
  page: {
    goto: ReturnType<typeof vi.fn>;
    waitForLoadState: ReturnType<typeof vi.fn>;
  };
};

const loadMockedTransport = async (
  headResponse: { ok: () => boolean } | null = { ok: () => true }
): Promise<MockTransport> => {
  const head = vi.fn(async () => headResponse);
  // `context` and `page` mock each other (`newPage` returns `page`, `page.context`
  // returns `context`); each reference is inside a closure invoked only later, so
  // declaring `page` after `context` (both `const`) works without a TDZ violation.
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
    route: vi.fn(async () => {}),
    request: {
      head
    }
  };
  const page: Record<string, unknown> = {
    $$eval: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    content: vi.fn(async () => "<html><body><main>Hello crawler</main></body></html>"),
    context: vi.fn(() => context),
    goto: vi.fn(async () => ({ status: () => 200 })),
    screenshot: vi.fn(async () => new Uint8Array([1, 2, 3])),
    title: vi.fn(async () => "Crawler page"),
    waitForLoadState: vi.fn(async () => {}),
    url: vi.fn(() => "https://example.com/docs")
  };
  const browser = {
    close: vi.fn(async () => {}),
    newContext: vi.fn(async () => context)
  };

  vi.doMock("playwright", () => ({
    chromium: {
      launch: vi.fn(async () => browser)
    }
  }));

  const { fetchPageWithScreenshot } = await import("../../src/transport/playwright.js");
  return { fetchPageWithScreenshot, head, page: page as MockTransport["page"] };
};

describe("Playwright transport", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("playwright");
  });

  it("validates fallback favicon probes before issuing the HEAD request", async () => {
    const { fetchPageWithScreenshot, head } = await loadMockedTransport();
    const validateNavigationUrl = vi.fn(async (candidateUrl: string) => {
      if (candidateUrl === "https://example.com/favicon.ico") {
        throw new Error("blocked by SSRF policy");
      }
    });

    const page = await fetchPageWithScreenshot("https://example.com/docs", {
      validateNavigationUrl
    });

    expect(validateNavigationUrl).toHaveBeenCalledWith("https://example.com/favicon.ico");
    expect(head).not.toHaveBeenCalled();
    expect(page.faviconUrl).toBeNull();
  });

  it("keeps favicon redirects disabled after validation succeeds", async () => {
    const { fetchPageWithScreenshot, head } = await loadMockedTransport();

    const page = await fetchPageWithScreenshot("https://example.com/docs", {
      validateNavigationUrl: vi.fn()
    });

    expect(head).toHaveBeenCalledWith("https://example.com/favicon.ico", { maxRedirects: 0 });
    expect(page.faviconUrl).toBe("https://example.com/favicon.ico");
  });

  it("uses domcontentloaded navigation and treats networkidle as a soft settle", async () => {
    const { fetchPageWithScreenshot, page } = await loadMockedTransport();
    page.waitForLoadState.mockRejectedValueOnce(new Error("networkidle timeout"));

    await expect(fetchPageWithScreenshot("https://example.com/docs")).resolves.toMatchObject({
      url: "https://example.com/docs",
      title: "Crawler page"
    });

    expect(page.goto).toHaveBeenCalledWith("https://example.com/docs", {
      waitUntil: "domcontentloaded",
      timeout: 30_000
    });
    expect(page.waitForLoadState).toHaveBeenCalledWith("networkidle", { timeout: 8000 });
  });
});
