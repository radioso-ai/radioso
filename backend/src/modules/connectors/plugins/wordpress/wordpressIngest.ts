/**
 * Mappers: WordPress payloads → ConnectorIngestionPort.ingest() input.
 *
 * Two input shapes:
 *   - WebhookPostPayload: what the companion PHP plugin pushes (raw + rendered).
 *   - WordpressRestPost: what the WP REST API returns (rendered only by default).
 *
 * Output is the same IngestInput in both cases.
 */

import type { ConnectorIngestContentFormat } from "@radioso/connector-api";

import type { WordpressRestPost } from "./wordpressClient.js";

export interface WebhookPostPayload {
  id: number;
  type: string;
  status: string;
  slug: string;
  title: string;
  content_rendered?: string;
  content_raw?: string;
  excerpt_rendered?: string;
  link: string;
  modified_gmt: string;
  author?: { id: number; name: string };
}

export interface IngestInput {
  workspaceId: string;
  title: string;
  content: string;
  contentFormat: ConnectorIngestContentFormat;
  externalDocumentId: string;
  metadata: Record<string, unknown>;
}

export const externalIdFor = (postId: number): string => `wp_post_${postId}`;

// Prefer `content_rendered` over `content_raw`: WordPress runs shortcodes,
// embeds and `the_content` filters when rendering, so the rendered version is
// closer to what a visitor actually reads. For Gutenberg posts the rendered
// HTML is also free of `<!-- wp:* -->` block delimiters. We still fall back to
// content_raw for clients that don't expose the rendered field.
//
// Both fields are HTML; the connector ingestion port handles the conversion to
// plain text via the shared HTML normaliser (declared by contentFormat below)
// so we don't carry a WordPress-specific extractor.
const pickHtml = (raw: string | undefined, rendered: string | undefined): string => {
  // Treat empty strings as "not provided": some REST clients return
  // `{ rendered: "", raw: "<p>…</p>" }` and we should fall through to raw.
  if (rendered && rendered.length > 0) return rendered;
  if (raw && raw.length > 0) return raw;
  return "";
};

export const mapWebhookPostToIngestInput = (
  workspaceId: string,
  post: WebhookPostPayload,
): IngestInput => {
  return {
    workspaceId,
    title: post.title || post.slug,
    content: pickHtml(post.content_raw, post.content_rendered),
    contentFormat: "html",
    externalDocumentId: externalIdFor(post.id),
    metadata: {
      source: "wordpress",
      wp_post_id: post.id,
      wp_post_type: post.type,
      wp_status: post.status,
      wp_slug: post.slug,
      sourceUrl: post.link,
      modified_at: post.modified_gmt,
      ...(post.author?.name ? { author: post.author.name } : {}),
    },
  };
};

export const mapRestPostToIngestInput = (
  workspaceId: string,
  post: WordpressRestPost,
): IngestInput => {
  return {
    workspaceId,
    title: post.title.rendered || post.slug,
    content: pickHtml(post.content.raw, post.content.rendered),
    contentFormat: "html",
    externalDocumentId: externalIdFor(post.id),
    metadata: {
      source: "wordpress",
      wp_post_id: post.id,
      wp_post_type: post.type,
      wp_status: post.status,
      wp_slug: post.slug,
      sourceUrl: post.link,
      modified_at: post.modified_gmt,
    },
  };
};
