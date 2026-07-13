import { describe, expect, it } from "vitest";

import type { WordpressRestPost } from "../../../../src/modules/connectors/plugins/wordpress/wordpressClient.js";
import {
  externalIdFor,
  mapRestPostToIngestInput,
  mapWebhookPostToIngestInput,
  type WebhookPostPayload,
} from "../../../../src/modules/connectors/plugins/wordpress/wordpressIngest.js";

const baseWebhookPost: WebhookPostPayload = {
  id: 42,
  type: "page",
  status: "publish",
  slug: "about",
  title: "About us",
  content_raw: "<!-- wp:paragraph --><p>Hello raw</p><!-- /wp:paragraph -->",
  content_rendered: "<p>Hello rendered</p>",
  excerpt_rendered: "Hello",
  link: "https://example.com/about",
  modified_gmt: "2026-05-16T12:00:00",
  date_gmt: "2026-05-10T08:30:00",
  author: { id: 1, name: "Alice" },
};

describe("externalIdFor", () => {
  it("namespaces post ids so they cannot collide with other connectors", () => {
    expect(externalIdFor(42)).toBe("wp_post_42");
  });
});

describe("mapWebhookPostToIngestInput", () => {
  it("prefers rendered HTML (post-filters) over raw block markup and tags the payload as HTML", () => {
    const result = mapWebhookPostToIngestInput("ws-1", baseWebhookPost);
    expect(result.workspaceId).toBe("ws-1");
    expect(result.externalDocumentId).toBe("wp_post_42");
    expect(result.title).toBe("About us");
    expect(result.content).toBe("<p>Hello rendered</p>");
    expect(result.contentFormat).toBe("html");
  });

  it("falls back to raw content when rendered is absent", () => {
    const result = mapWebhookPostToIngestInput("ws-1", {
      ...baseWebhookPost,
      content_rendered: undefined,
    });
    expect(result.content).toBe("<!-- wp:paragraph --><p>Hello raw</p><!-- /wp:paragraph -->");
    expect(result.contentFormat).toBe("html");
  });

  it("uses the slug when the title is empty", () => {
    const result = mapWebhookPostToIngestInput("ws-1", { ...baseWebhookPost, title: "" });
    expect(result.title).toBe("about");
  });

  it("populates source metadata for downstream filtering", () => {
    const { metadata } = mapWebhookPostToIngestInput("ws-1", baseWebhookPost);
    expect(metadata).toMatchObject({
      source: "wordpress",
      wp_post_id: 42,
      wp_post_type: "page",
      wp_status: "publish",
      wp_slug: "about",
      sourceUrl: "https://example.com/about",
      modified_at: "2026-05-16T12:00:00",
      author: "Alice",
    });
    expect(metadata).not.toHaveProperty("url");
  });

  it("captures the publish date so the post is findable and filterable by date", () => {
    const { metadata } = mapWebhookPostToIngestInput("ws-1", baseWebhookPost);
    // Raw timestamp for provenance/display, plus the platform date-metadata key
    // (ISO day) so retrieval search text and metadata date rules pick it up.
    expect(metadata).toMatchObject({
      published_at: "2026-05-10T08:30:00",
      dateFrom: "2026-05-10",
    });
  });

  it("omits publish-date metadata when the post has no publish date", () => {
    const { metadata } = mapWebhookPostToIngestInput("ws-1", { ...baseWebhookPost, date_gmt: undefined });
    expect(metadata).not.toHaveProperty("published_at");
    expect(metadata).not.toHaveProperty("dateFrom");
  });

  it("omits author metadata when not provided", () => {
    const { metadata } = mapWebhookPostToIngestInput("ws-1", { ...baseWebhookPost, author: undefined });
    expect(metadata).not.toHaveProperty("author");
  });
});

describe("mapRestPostToIngestInput", () => {
  const restPost: WordpressRestPost = {
    id: 7,
    type: "post",
    status: "publish",
    slug: "hello-world",
    link: "https://example.com/hello-world",
    modified_gmt: "2026-05-15T09:00:00",
    date_gmt: "2026-05-07T14:00:00",
    title: { rendered: "Hello World" },
    content: { rendered: "<p>From REST</p>" },
  };

  it("maps a REST API post into the same shape as a webhook post and tags the payload as HTML", () => {
    const result = mapRestPostToIngestInput("ws-1", restPost);
    expect(result.externalDocumentId).toBe("wp_post_7");
    expect(result.title).toBe("Hello World");
    expect(result.content).toBe("<p>From REST</p>");
    expect(result.contentFormat).toBe("html");
    expect(result.metadata).toMatchObject({
      wp_post_id: 7,
      wp_post_type: "post",
      sourceUrl: "https://example.com/hello-world",
    });
    expect(result.metadata).not.toHaveProperty("url");
  });

  it("falls back to content.raw when rendered is absent", () => {
    const result = mapRestPostToIngestInput("ws-1", {
      ...restPost,
      content: { rendered: "", raw: "<p>raw body</p>" },
    });
    expect(result.content).toBe("<p>raw body</p>");
  });

  it("captures the publish date from the REST post into date metadata", () => {
    const { metadata } = mapRestPostToIngestInput("ws-1", restPost);
    expect(metadata).toMatchObject({
      published_at: "2026-05-07T14:00:00",
      dateFrom: "2026-05-07",
    });
  });

  it("omits publish-date metadata when the REST post has no publish date", () => {
    const { metadata } = mapRestPostToIngestInput("ws-1", { ...restPost, date_gmt: undefined });
    expect(metadata).not.toHaveProperty("published_at");
    expect(metadata).not.toHaveProperty("dateFrom");
  });

  it("captures the embedded author name into metadata so the post is findable by author", () => {
    const result = mapRestPostToIngestInput("ws-1", {
      ...restPost,
      author: 3,
      _embedded: { author: [{ id: 3, name: "Sabine Kaphingst" }] },
    });
    expect(result.metadata).toMatchObject({ author: "Sabine Kaphingst" });
  });

  it("omits author metadata when no embedded author is present", () => {
    const result = mapRestPostToIngestInput("ws-1", restPost);
    expect(result.metadata).not.toHaveProperty("author");
  });

  it("omits author metadata when the embedded author name is blank", () => {
    const result = mapRestPostToIngestInput("ws-1", {
      ...restPost,
      author: 3,
      _embedded: { author: [{ id: 3, name: "   " }] },
    });
    expect(result.metadata).not.toHaveProperty("author");
  });
});
