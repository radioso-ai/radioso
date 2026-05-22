/**
 * Minimal typed client for the WordPress core REST API (/wp-json/wp/v2/).
 *
 * Supports Application Password auth via HTTP Basic. Pagination uses the
 * standard X-WP-TotalPages response header.
 */

/**
 * Maps a WordPress post-type slug to its REST API base (`rest_base`).
 *
 * The connector config stores post-type slugs (`post`, `page`, `tribe_events`)
 * because that is what the WordPress UI labels them. The REST API exposes the
 * same content under `rest_base` which for built-in types is the plural form
 * (`posts`, `pages`). For custom types it is whatever the plugin registers;
 * users may type the rest_base directly when configuring uncommon types.
 */
const REST_BASE_BY_POST_TYPE: Record<string, string> = {
  post: "posts",
  page: "pages",
  attachment: "media",
};

const restBaseFor = (postType: string): string => REST_BASE_BY_POST_TYPE[postType] ?? postType;

export interface WordpressClientConfig {
  siteUrl: string;
  username?: string;
  applicationPassword?: string;
  /** Override for testing. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface WordpressRestPost {
  id: number;
  type: string;
  status: string;
  slug: string;
  link: string;
  modified_gmt: string;
  title: { rendered: string };
  content: { rendered: string; raw?: string };
  excerpt?: { rendered: string };
  author?: number;
}

export interface FetchPostsOptions {
  type: string;
  page: number;
  perPage: number;
  modifiedAfter?: string;
}

export interface FetchPostsResult {
  posts: WordpressRestPost[];
  totalPages: number;
}

export class WordpressClient {
  private readonly baseUrl: string;
  private readonly authHeader: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(config: WordpressClientConfig) {
    this.baseUrl = config.siteUrl.replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.authHeader =
      config.username && config.applicationPassword
        ? `Basic ${Buffer.from(`${config.username}:${config.applicationPassword}`).toString("base64")}`
        : null;
  }

  buildPostsUrl(options: FetchPostsOptions): string {
    const params = new URLSearchParams({
      page: String(options.page),
      per_page: String(options.perPage),
      orderby: "modified",
      order: "asc",
      status: "publish",
      _fields: "id,type,status,slug,link,modified_gmt,title,content,excerpt,author",
    });
    if (options.modifiedAfter) {
      params.set("modified_after", options.modifiedAfter);
    }
    return `${this.baseUrl}/wp-json/wp/v2/${encodeURIComponent(restBaseFor(options.type))}?${params.toString()}`;
  }

  async fetchPostsPage(options: FetchPostsOptions): Promise<FetchPostsResult> {
    const url = this.buildPostsUrl(options);
    const response = await this.fetchImpl(url, {
      headers: this.authHeader ? { Authorization: this.authHeader, Accept: "application/json" } : { Accept: "application/json" },
    });

    if (response.status === 400 && options.page > 1) {
      // WP returns 400 "rest_post_invalid_page_number" past last page.
      return { posts: [], totalPages: options.page - 1 };
    }
    if (response.status === 404) {
      // Custom post types whose rest_base isn't registered (or that the user
      // typed wrong) silently return no posts rather than erroring out the
      // whole backfill — keeps the configured types that *do* exist working.
      return { posts: [], totalPages: 0 };
    }
    if (!response.ok) {
      throw new Error(`WordPress REST returned ${response.status} ${response.statusText} for ${url}`);
    }

    const posts = (await response.json()) as WordpressRestPost[];
    const totalPagesHeader = response.headers.get("x-wp-totalpages");
    const totalPages = totalPagesHeader ? Number.parseInt(totalPagesHeader, 10) : options.page;
    return { posts, totalPages: Number.isFinite(totalPages) ? totalPages : options.page };
  }

  async fetchPostById(type: string, postId: number): Promise<WordpressRestPost | null> {
    const url = `${this.baseUrl}/wp-json/wp/v2/${encodeURIComponent(restBaseFor(type))}/${postId}?_fields=id,type,status,slug,link,modified_gmt,title,content,excerpt,author`;
    const response = await this.fetchImpl(url, {
      headers: this.authHeader ? { Authorization: this.authHeader, Accept: "application/json" } : { Accept: "application/json" },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`WordPress REST returned ${response.status} ${response.statusText} for ${url}`);
    }
    return (await response.json()) as WordpressRestPost;
  }
}
