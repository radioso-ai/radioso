/**
 * Mappers: WordPress payloads → ConnectorIngestionPort.ingest() input.
 *
 * Two input shapes:
 *   - WebhookPostPayload: what the companion PHP plugin pushes (raw + rendered).
 *   - WordpressRestPost: what the WP REST API returns (rendered only by default).
 *
 * Output is the same IngestInput in both cases.
 */

import type {
  ConnectorIndexedFieldValue,
  ConnectorIngestContentFormat,
} from "@radioso/connector-api";

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
  date_gmt?: string;
  // `id` is absent when the author came from a taxonomy rather than a WordPress
  // account; only the name is ever read.
  author?: { id?: number; name: string };
  // Facts the site publishes for retrieval to filter and boost on — a product's
  // price, its stock status. The site owns this vocabulary; nothing here knows
  // what a WooCommerce product is.
  fields?: Record<string, ConnectorIndexedFieldValue>;
}

export interface IngestInput {
  workspaceId: string;
  title: string;
  content: string;
  contentFormat: ConnectorIngestContentFormat;
  externalDocumentId: string;
  metadata: Record<string, unknown>;
  indexedFields?: Record<string, ConnectorIndexedFieldValue>;
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

// The author name is theme-rendered chrome the post body never contains, so we
// surface it as metadata. The REST API only exposes it under the embedded
// author relation (see WordpressClient `_embed=author`).
const extractRestAuthorName = (post: WordpressRestPost): string | undefined => {
  const name = post._embedded?.author?.[0]?.name;
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
};

const ISO_DAY_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

// The publish date is theme-rendered chrome (a byline/date line the post body
// never contains) so we surface it as metadata. We keep the raw WordPress GMT
// timestamp under `published_at` for provenance/display and derive the ISO day
// into `dateFrom` — the platform's date-metadata key that retrieval search text
// and operator date rules already understand.
const buildPublishDateMetadata = (dateGmt: string | undefined): Record<string, string> => {
  const raw = dateGmt?.trim();
  if (!raw) {
    return {};
  }
  const isoDay = ISO_DAY_PREFIX.exec(raw)?.[1];
  return {
    published_at: raw,
    ...(isoDay ? { dateFrom: isoDay } : {}),
  };
};

export const mapWebhookPostToIngestInput = (
  workspaceId: string,
  post: WebhookPostPayload,
): IngestInput => {
  // Kept out of `metadata` on the way down: ingestion re-indexes on a change to
  // these but not on a change to the bookkeeping around them, which WordPress
  // rewrites on every save.
  const hasIndexedFields = post.fields !== undefined && Object.keys(post.fields).length > 0;
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
      ...buildPublishDateMetadata(post.date_gmt),
      ...(post.author?.name ? { author: post.author.name } : {}),
    },
    ...(hasIndexedFields ? { indexedFields: post.fields } : {}),
  };
};

export const mapRestPostToIngestInput = (
  workspaceId: string,
  post: WordpressRestPost,
): IngestInput => {
  const authorName = extractRestAuthorName(post);
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
      ...buildPublishDateMetadata(post.date_gmt),
      ...(authorName ? { author: authorName } : {}),
    },
  };
};
