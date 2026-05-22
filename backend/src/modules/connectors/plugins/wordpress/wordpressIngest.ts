/**
 * Mappers: WordPress payloads → ConnectorIngestionPort.ingest() input.
 *
 * Two input shapes:
 *   - WebhookPostPayload: what the companion PHP plugin pushes (raw + rendered).
 *   - WordpressRestPost: what the WP REST API returns (rendered only by default).
 *
 * Output is the same IngestInput in both cases.
 */

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
  externalDocumentId: string;
  metadata: Record<string, unknown>;
}

export const externalIdFor = (postId: number): string => `wp_post_${postId}`;

const stripHtmlComments = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, "");

export const mapWebhookPostToIngestInput = (
  workspaceId: string,
  post: WebhookPostPayload,
): IngestInput => {
  // Prefer raw block content (Gutenberg) when available; the document parser
  // can interpret block markup. Otherwise fall back to rendered HTML.
  const content = stripHtmlComments(post.content_raw ?? post.content_rendered ?? "").trim();

  return {
    workspaceId,
    title: post.title || post.slug,
    content,
    externalDocumentId: externalIdFor(post.id),
    metadata: {
      source: "wordpress",
      wp_post_id: post.id,
      wp_post_type: post.type,
      wp_status: post.status,
      wp_slug: post.slug,
      url: post.link,
      modified_at: post.modified_gmt,
      ...(post.author?.name ? { author: post.author.name } : {}),
    },
  };
};

export const mapRestPostToIngestInput = (
  workspaceId: string,
  post: WordpressRestPost,
): IngestInput => {
  const content = stripHtmlComments(post.content.raw ?? post.content.rendered ?? "").trim();
  return {
    workspaceId,
    title: post.title.rendered || post.slug,
    content,
    externalDocumentId: externalIdFor(post.id),
    metadata: {
      source: "wordpress",
      wp_post_id: post.id,
      wp_post_type: post.type,
      wp_status: post.status,
      wp_slug: post.slug,
      url: post.link,
      modified_at: post.modified_gmt,
    },
  };
};
