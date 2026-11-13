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

  it("dates a post by its publish day, the period a dated entry covers", () => {
    const { metadata } = mapWebhookPostToIngestInput("ws-1", { ...baseWebhookPost, type: "post" });
    // Raw timestamp for provenance/display, plus the platform date-metadata key
    // (ISO day) so retrieval search text and metadata date rules pick it up.
    expect(metadata).toMatchObject({
      published_at: "2026-05-10T08:30:00",
      dateFrom: "2026-05-10",
    });
  });

  it.each(["page", "product", "tribe_events"])(
    "keeps a %s's publish timestamp without dating its content by it",
    (type) => {
      const { metadata } = mapWebhookPostToIngestInput("ws-1", { ...baseWebhookPost, type });
      expect(metadata).toMatchObject({ published_at: "2026-05-10T08:30:00" });
      expect(metadata).not.toHaveProperty("dateFrom");
    },
  );

  it("omits publish-date metadata when the post has no publish date", () => {
    const { metadata } = mapWebhookPostToIngestInput("ws-1", {
      ...baseWebhookPost,
      type: "post",
      date_gmt: undefined,
    });
    expect(metadata).not.toHaveProperty("published_at");
    expect(metadata).not.toHaveProperty("dateFrom");
  });

  it("keeps a taxonomy-sourced author that carries no WordPress user id", () => {
    // Catalogue post types keep the author of the work in a taxonomy, so the
    // companion plugin sends a name with no account behind it.
    const { metadata } = mapWebhookPostToIngestInput("ws-1", {
      ...baseWebhookPost,
      author: { name: "Swami Selan" },
    });
    expect(metadata).toMatchObject({ author: "Swami Selan" });
  });

  it("omits author metadata when not provided", () => {
    const { metadata } = mapWebhookPostToIngestInput("ws-1", { ...baseWebhookPost, author: undefined });
    expect(metadata).not.toHaveProperty("author");
  });
});

describe("mapWebhookPostToIngestInput indexed fields", () => {
  it("carries scalar fields separately so a change to one re-indexes the document", () => {
    const result = mapWebhookPostToIngestInput("ws-1", {
      ...baseWebhookPost,
      fields: { price: 17, on_sale: false, sku: "AEY0112" },
    });
    expect(result.indexedFields).toEqual({ price: 17, on_sale: false, sku: "AEY0112" });
  });

  it("omits indexed fields when the site publishes none", () => {
    expect(mapWebhookPostToIngestInput("ws-1", baseWebhookPost).indexedFields).toBeUndefined();
    expect(
      mapWebhookPostToIngestInput("ws-1", { ...baseWebhookPost, fields: {} }).indexedFields,
    ).toBeUndefined();
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

  it("keeps a REST page's publish timestamp without dating its content by it", () => {
    const { metadata } = mapRestPostToIngestInput("ws-1", { ...restPost, type: "page" });
    expect(metadata).toMatchObject({ published_at: "2026-05-07T14:00:00" });
    expect(metadata).not.toHaveProperty("dateFrom");
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

  describe("the featured image", () => {
    const withMedia = (media: NonNullable<WordpressRestPost["_embedded"]>["wp:featuredmedia"]): WordpressRestPost => ({
      ...restPost,
      featured_media: 91,
      _embedded: { "wp:featuredmedia": media },
    });

    it("is the post's picture, at the smallest size still wide enough for the widest stored copy", () => {
      const result = mapRestPostToIngestInput("ws-1", withMedia([{
        source_url: "https://example.com/uploads/cover.jpg",
        alt_text: "The cover",
        media_details: {
          width: 2400,
          sizes: {
            thumbnail: { source_url: "https://example.com/uploads/cover-150.jpg", width: 150 },
            medium_large: { source_url: "https://example.com/uploads/cover-768.jpg", width: 768 },
            large: { source_url: "https://example.com/uploads/cover-1024.jpg", width: 1024 },
          },
        },
      }]));

      expect(result.images).toEqual([{ url: "https://example.com/uploads/cover-768.jpg", alt: "The cover" }]);
    });

    it("falls back to the original when no size is wide enough", () => {
      const result = mapRestPostToIngestInput("ws-1", withMedia([{ source_url: "https://example.com/uploads/small.png", media_details: { sizes: {} } }]));

      expect(result.images).toEqual([{ url: "https://example.com/uploads/small.png", alt: "" }]);
    });

    it("says the post has none when it has no featured image, or the site does not let it be read", () => {
      expect(mapRestPostToIngestInput("ws-1", { ...restPost, featured_media: 0 }).images).toEqual([]);
      expect(mapRestPostToIngestInput("ws-1", withMedia([{}])).images).toEqual([]);
    });
  });
});

describe("mapWebhookPostToIngestInput featured image", () => {
  it("carries the pushed featured image as the post's picture", () => {
    const result = mapWebhookPostToIngestInput("ws-1", {
      ...baseWebhookPost,
      featured_image: { url: "https://example.com/uploads/cover.jpg", alt: "The cover" },
    });

    expect(result.images).toEqual([{ url: "https://example.com/uploads/cover.jpg", alt: "The cover" }]);
  });

  it("says the post has none when the plugin pushes none, and says nothing when an older plugin does not know the field", () => {
    expect(mapWebhookPostToIngestInput("ws-1", { ...baseWebhookPost, featured_image: null }).images).toEqual([]);
    expect(mapWebhookPostToIngestInput("ws-1", baseWebhookPost)).not.toHaveProperty("images");
  });
});
