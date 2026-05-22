import { describe, expect, it, vi } from "vitest";

import { WordpressClient } from "../../../../src/modules/connectors/plugins/wordpress/wordpressClient.js";

const okJsonResponse = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });

describe("WordpressClient", () => {
  it("builds the posts URL with auth, fields, pagination, and modified_after", () => {
    const client = new WordpressClient({
      siteUrl: "https://example.com/",
      username: "alice",
      applicationPassword: "abcd 1234",
    });
    const url = client.buildPostsUrl({
      type: "page",
      page: 2,
      perPage: 50,
      modifiedAfter: "2026-05-15T00:00:00",
    });

    expect(url).toMatch(/^https:\/\/example\.com\/wp-json\/wp\/v2\/page\?/);
    const params = new URL(url).searchParams;
    expect(params.get("page")).toBe("2");
    expect(params.get("per_page")).toBe("50");
    expect(params.get("orderby")).toBe("modified");
    expect(params.get("order")).toBe("asc");
    expect(params.get("status")).toBe("publish");
    expect(params.get("modified_after")).toBe("2026-05-15T00:00:00");
  });

  it("sends Basic auth header when credentials are configured", async () => {
    const fetchImpl = vi.fn(async () => okJsonResponse([], { "x-wp-totalpages": "1" }));
    const client = new WordpressClient({
      siteUrl: "https://example.com",
      username: "alice",
      applicationPassword: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.fetchPostsPage({ type: "page", page: 1, perPage: 10 });

    const call = fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("alice:secret").toString("base64")}`);
  });

  it("omits the Authorization header when credentials are absent", async () => {
    const fetchImpl = vi.fn(async () => okJsonResponse([], { "x-wp-totalpages": "1" }));
    const client = new WordpressClient({
      siteUrl: "https://example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.fetchPostsPage({ type: "page", page: 1, perPage: 10 });

    const call = fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("parses X-WP-TotalPages header into the result", async () => {
    const fetchImpl = vi.fn(async () =>
      okJsonResponse([{ id: 1 }], { "x-wp-totalpages": "5" }),
    );
    const client = new WordpressClient({
      siteUrl: "https://example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.fetchPostsPage({ type: "post", page: 1, perPage: 10 });
    expect(result.totalPages).toBe(5);
    expect(result.posts).toHaveLength(1);
  });

  it("treats HTTP 400 past the last page as an empty result", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: "rest_post_invalid_page_number" }), { status: 400 }),
    );
    const client = new WordpressClient({
      siteUrl: "https://example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.fetchPostsPage({ type: "post", page: 9, perPage: 10 });
    expect(result.posts).toEqual([]);
    expect(result.totalPages).toBe(8);
  });

  it("throws on non-ok responses for the first page", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const client = new WordpressClient({
      siteUrl: "https://example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.fetchPostsPage({ type: "post", page: 1, perPage: 10 }),
    ).rejects.toThrow(/500/);
  });
});
