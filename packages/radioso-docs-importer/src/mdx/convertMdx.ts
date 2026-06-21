import matter from "gray-matter";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";

/**
 * A docs-portal MDX page flattened into plain markdown suitable for ingestion.
 * The flattening is purely structural: it preserves prose carried by Nextra JSX
 * components (Callout/Cards/Steps) instead of dropping it, and rewrites
 * root-relative links to absolute docs URLs so citations resolve.
 */
export interface ConvertedMdxDocument {
  title: string;
  description?: string;
  markdown: string;
}

export interface ConvertMdxOptions {
  /** Stable slug used as a title fallback, e.g. `quickstarts/run-locally`. */
  slug: string;
  /** Absolute base for the public docs site, e.g. `https://docs.radioso.ai`. */
  citationBase: string;
}

// Minimal mdast/mdx node shapes we touch. The full unist tree is `unknown`-ish;
// we narrow only the fields this transform reads or rewrites.
interface Node {
  type: string;
  children?: Node[];
  value?: string;
  url?: string;
  name?: string | null;
  attributes?: JsxAttribute[];
}

interface JsxAttribute {
  type: string;
  name?: string;
  value?: unknown;
}

const DROP_TYPES = new Set(["mdxjsEsm", "mdxFlowExpression", "mdxTextExpression"]);
const JSX_TYPES = new Set(["mdxJsxFlowElement", "mdxJsxTextElement"]);

export function convertMdxDocument(source: string, options: ConvertMdxOptions): ConvertedMdxDocument {
  const { data, content } = matter(source);
  const citationBase = options.citationBase.replace(/\/+$/, "");

  const processor = remark().use(remarkMdx).use(remarkGfm);
  const tree = processor.parse(content) as Node;
  flattenChildren(tree, citationBase);
  const markdown = processor.stringify(tree as never).trim();

  const frontmatterTitle = typeof data.title === "string" ? data.title.trim() : "";
  const title = frontmatterTitle || firstHeadingText(tree) || options.slug;
  const description = typeof data.description === "string" ? data.description.trim() : undefined;

  return { title, description, markdown };
}

function flattenChildren(parent: Node, citationBase: string): void {
  if (!parent.children) {
    return;
  }
  const next: Node[] = [];
  for (const child of parent.children) {
    flattenChildren(child, citationBase);
    next.push(...transformNode(child, citationBase));
  }
  parent.children = next;
}

function transformNode(node: Node, citationBase: string): Node[] {
  if (DROP_TYPES.has(node.type)) {
    return [];
  }

  if (node.type === "link" && typeof node.url === "string") {
    node.url = absolutize(node.url, citationBase);
    return [node];
  }

  if (JSX_TYPES.has(node.type)) {
    return flattenJsxElement(node, citationBase);
  }

  return [node];
}

/** Replace a Nextra JSX element with its prose: synthesize a heading/link from
 * `title`/`href` attributes, then keep the (already-flattened) children. */
function flattenJsxElement(node: Node, citationBase: string): Node[] {
  const title = stringAttribute(node, "title");
  const href = stringAttribute(node, "href");
  const children = node.children ?? [];
  const prefix: Node[] = [];

  if (href) {
    prefix.push(paragraph([{ type: "link", url: absolutize(href, citationBase), children: [text(title ?? href)] }]));
  } else if (title) {
    prefix.push(paragraph([{ type: "strong", children: [text(title)] }]));
  }

  return [...prefix, ...children];
}

function stringAttribute(node: Node, name: string): string | undefined {
  const attr = node.attributes?.find((candidate) => candidate.type === "mdxJsxAttribute" && candidate.name === name);
  return typeof attr?.value === "string" ? attr.value : undefined;
}

function absolutize(url: string, citationBase: string): string {
  return url.startsWith("/") ? `${citationBase}${url}` : url;
}

function firstHeadingText(tree: Node): string {
  const heading = tree.children?.find((node) => node.type === "heading");
  if (!heading) {
    return "";
  }
  return collectText(heading).trim();
}

function collectText(node: Node): string {
  if (node.type === "text" && typeof node.value === "string") {
    return node.value;
  }
  return (node.children ?? []).map(collectText).join("");
}

function paragraph(children: Node[]): Node {
  return { type: "paragraph", children };
}

function text(value: string): Node {
  return { type: "text", value };
}
