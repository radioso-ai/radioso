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

    // WordPress REST exposes the `page` post type at the plural `pages` base.
    expect(url).toMatch(/^https:\/\/example\.com\/wp-json\/wp\/v2\/pages\?/);
    const params = new URL(url).searchParams;
    expect(params.get("page")).toBe("2");
    expect(params.get("per_page")).toBe("50");
    expect(params.get("orderby")).toBe("modified");
    expect(params.get("order")).toBe("asc");
    expect(params.get("status")).toBe("publish");
    expect(params.get("modified_after")).toBe("2026-05-15T00:00:00");
    // Author name only travels in the embedded author relation, so we request
    // embedding and keep the embedded payload in _fields.
    expect(params.get("_embed")).toBe("author");
    expect(params.get("_fields")).toContain("_embedded.author");
  });

  it("maps built-in post types to their REST base (page→pages, post→posts) and passes custom types through", () => {
    const client = new WordpressClient({ siteUrl: "https://example.com" });
    expect(client.buildPostsUrl({ type: "page", page: 1, perPage: 1 })).toContain("/wp-json/wp/v2/pages?");
    expect(client.buildPostsUrl({ type: "post", page: 1, perPage: 1 })).toContain("/wp-json/wp/v2/posts?");
    expect(client.buildPostsUrl({ type: "tribe_events", page: 1, perPage: 1 })).toContain("/wp-json/wp/v2/tribe_events?");
  });

  it("returns an empty page on 404 so unknown custom post types don't break backfill", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 }));
    const client = new WordpressClient({
      siteUrl: "https://example.com",
      fetchImpl: fetchImpl,
    });

    const result = await client.fetchPostsPage({ type: "event", page: 1, perPage: 10 });
    expect(result).toEqual({ posts: [], totalPages: 0 });
  });

  it("sends Basic auth header when credentials are configured", async () => {
    const fetchImpl = vi.fn(async () => okJsonResponse([], { "x-wp-totalpages": "1" }));
    const client = new WordpressClient({
      siteUrl: "https://example.com",
      username: "alice",
      applicationPassword: "secret",
      fetchImpl: fetchImpl,
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
      fetchImpl: fetchImpl,
    });

    await client.fetchPostsPage({ type: "page", page: 1, perPage: 10 });

    const call = fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("validates every redirect hop and never forwards credentials across origins", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://www.example.com/wp-json/wp/v2/pages" },
      }))
      .mockResolvedValueOnce(okJsonResponse([], { "x-wp-totalpages": "1" }));
    const assertPublicUrl = vi.fn(async () => undefined);
    const client = new WordpressClient({
      siteUrl: "https://example.com",
      username: "alice",
      applicationPassword: "secret",
      fetchImpl: fetchImpl,
      assertPublicUrl,
    });

    await client.fetchPostsPage({ type: "page", page: 1, perPage: 10 });

    expect(assertPublicUrl).toHaveBeenCalledTimes(2);
    expect(assertPublicUrl).toHaveBeenNthCalledWith(2, "https://www.example.com/wp-json/wp/v2/pages");
    const firstInit = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const secondInit = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    expect(firstInit.redirect).toBe("manual");
    expect((firstInit.headers as Record<string, string>).Authorization).toBeDefined();
    expect((secondInit.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("rejects a blocked destination before issuing a request", async () => {
    const fetchImpl = vi.fn();
    const client = new WordpressClient({
      siteUrl: "http://127.0.0.1",
      fetchImpl: fetchImpl,
      assertPublicUrl: async () => {
        throw new Error("publicly routable host required");
      },
    });

    await expect(client.fetchPostsPage({ type: "page", page: 1, perPage: 10 }))
      .rejects.toThrow("publicly routable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("parses X-WP-TotalPages header into the result", async () => {
    const fetchImpl = vi.fn(async () =>
      okJsonResponse([{ id: 1 }], { "x-wp-totalpages": "5" }),
    );
    const client = new WordpressClient({
      siteUrl: "https://example.com",
      fetchImpl: fetchImpl,
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
      fetchImpl: fetchImpl,
    });

    const result = await client.fetchPostsPage({ type: "post", page: 9, perPage: 10 });
    expect(result.posts).toEqual([]);
    expect(result.totalPages).toBe(8);
  });

  it("throws on non-ok responses for the first page", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const client = new WordpressClient({
      siteUrl: "https://example.com",
      fetchImpl: fetchImpl,
    });

    await expect(
      client.fetchPostsPage({ type: "post", page: 1, perPage: 10 }),
    ).rejects.toThrow(/500/);
  });
});
