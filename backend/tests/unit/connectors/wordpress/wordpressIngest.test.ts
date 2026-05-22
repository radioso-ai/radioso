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
      url: "https://example.com/about",
      modified_at: "2026-05-16T12:00:00",
      author: "Alice",
    });
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
    title: { rendered: "Hello World" },
    content: { rendered: "<p>From REST</p>" },
  };

  it("maps a REST API post into the same shape as a webhook post and tags the payload as HTML", () => {
    const result = mapRestPostToIngestInput("ws-1", restPost);
    expect(result.externalDocumentId).toBe("wp_post_7");
    expect(result.title).toBe("Hello World");
    expect(result.content).toBe("<p>From REST</p>");
    expect(result.contentFormat).toBe("html");
    expect(result.metadata).toMatchObject({ wp_post_id: 7, wp_post_type: "post" });
  });

  it("falls back to content.raw when rendered is absent", () => {
    const result = mapRestPostToIngestInput("ws-1", {
      ...restPost,
      content: { rendered: "", raw: "<p>raw body</p>" },
    });
    expect(result.content).toBe("<p>raw body</p>");
  });
});
