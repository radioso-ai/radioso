import { z } from "zod";

import type { CopilotToolDescriptor } from "../contracts.js";
import { compactForBudget, withTruncation } from "../payloadCompaction.js";
import type { ProductDoc, ProductDocSection, ProductDocSummary } from "../../productDocs/public.js";

/**
 * A documentation page is prose the operator will read back, so the default compaction profile —
 * which caps every string at 500 characters — would return an unusable fragment. These bounds keep
 * a whole page readable in one call while still refusing to spend an unbounded share of the turn.
 */
const DOCS_PAYLOAD_CHAR_BUDGET = 24_000;
const PAGE_INLINE_CHAR_BUDGET = 18_000;

const boundDocsPayload = (payload: Record<string, unknown>): Record<string, unknown> => {
  const compacted = compactForBudget(
    payload,
    [
      { maxStringChars: 12_000, maxArrayItems: 120 },
      { maxStringChars: 6_000, maxArrayItems: 80 },
      { maxStringChars: 2_000, maxArrayItems: 60 },
    ],
    DOCS_PAYLOAD_CHAR_BUDGET,
  );
  return withTruncation(compacted.value, compacted.truncation);
};

export interface CopilotProductDocsPort {
  list(): readonly ProductDocSummary[];
  read(slug: string): ProductDoc | null;
  readSection(slug: string, sectionId: string): ProductDocSection | null;
}

export interface ProductDocsCopilotToolDependencies {
  readonly productDocs: CopilotProductDocsPort;
}

const summarySchema = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  section: z.string(),
  url: z.string(),
  headings: z.array(z.string()),
  lastUpdated: z.string().nullable(),
});

const indexOutputSchema = z.object({
  pages: z.array(summarySchema),
});

const pageInputSchema = z.object({
  slug: z.string().trim().min(1).max(200),
  section: z.string().trim().min(1).max(200).optional(),
}).strict();

const pageOutputSchema = z.object({
  found: z.boolean(),
  page: z.object({
    slug: z.string(),
    title: z.string(),
    description: z.string(),
    url: z.string(),
    lastUpdated: z.string().nullable(),
    intro: z.string(),
    sections: z.array(z.object({ id: z.string(), heading: z.string(), body: z.string() })),
    /** Set when the page was too long to inline; read the listed sections one at a time. */
    sectionsOmitted: z.array(z.object({ id: z.string(), heading: z.string() })).optional(),
  }).optional(),
  /** Present when the slug or section did not resolve, so the model corrects instead of inventing. */
  availableSlugs: z.array(z.string()).optional(),
  availableSections: z.array(z.string()).optional(),
}).strict();

const INDEX_DESCRIPTION = "List every page of Radioso's own product documentation — the manual for "
  + "how Radioso works — with each page's slug, summary, and section headings. Use this to find the "
  + "page that explains a Radioso concept, setting, or API before reading it. This is not the "
  + "workspace's own knowledge base; use document_search for the documents this workspace ingested.";

const PAGE_DESCRIPTION = "Read one page of Radioso's own product documentation by slug, optionally "
  + "one section of it. Use this to ground an explanation of how Radioso works in the documentation "
  + "shipped with this release, rather than from memory. This is not the workspace's own knowledge "
  + "base; use document_search for the documents this workspace ingested.";

export const createProductDocsCopilotTools = (
  deps: ProductDocsCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "product_docs",
    shape: "read",
    verificationCost: () => 0,
    uiLabel: "Reading the Radioso documentation index",
    contributingModule: "productDocs",
    dashboardSubject: { type: "documentation" },
    requiredPermissions: ["workspace.summary.read"],
    description: INDEX_DESCRIPTION,
    inputSchema: z.object({}).strict(),
    outputSchema: indexOutputSchema,
    createTool: () => ({
      name: "product_docs",
      description: INDEX_DESCRIPTION,
      inputSchema: z.object({}).strict(),
      outputSchema: indexOutputSchema,
      invoke: async () => boundDocsPayload({
        pages: deps.productDocs.list().map((page) => ({
          slug: page.slug,
          title: page.title,
          description: page.description,
          section: page.section,
          url: page.url,
          headings: [...page.headings],
          lastUpdated: page.lastUpdated,
        })),
      }),
    }),
  },
  {
    name: "product_doc_page",
    shape: "read",
    verificationCost: () => 0,
    uiLabel: "Reading a Radioso documentation page",
    contributingModule: "productDocs",
    dashboardSubject: { type: "documentation" },
    requiredPermissions: ["workspace.summary.read"],
    description: PAGE_DESCRIPTION,
    inputSchema: pageInputSchema,
    outputSchema: pageOutputSchema,
    createTool: () => ({
      name: "product_doc_page",
      description: PAGE_DESCRIPTION,
      inputSchema: pageInputSchema,
      outputSchema: pageOutputSchema,
      invoke: async (input: z.infer<typeof pageInputSchema>) => {
        const page = deps.productDocs.read(input.slug);
        if (!page) {
          return boundDocsPayload({
            found: false,
            availableSlugs: deps.productDocs.list().map((summary) => summary.slug),
          });
        }

        const header = {
          slug: page.slug,
          title: page.title,
          description: page.description,
          url: page.url,
          lastUpdated: page.lastUpdated,
        };

        if (input.section) {
          const section = deps.productDocs.readSection(page.slug, input.section);
          if (!section) {
            return boundDocsPayload({
              found: false,
              availableSections: page.sections.map((candidate) => candidate.id),
            });
          }
          return boundDocsPayload({ found: true, page: { ...header, intro: "", sections: [{ ...section }] } });
        }

        // A long page is answered with its outline rather than a silently clipped body: an operator
        // acting on a truncated procedure is worse off than one told which section to open.
        const inlineLength = page.intro.length
          + page.sections.reduce((total, section) => total + section.heading.length + section.body.length, 0);
        if (inlineLength > PAGE_INLINE_CHAR_BUDGET) {
          return boundDocsPayload({
            found: true,
            page: {
              ...header,
              intro: page.intro,
              sections: [],
              sectionsOmitted: page.sections.map(({ id, heading }) => ({ id, heading })),
            },
          });
        }

        return boundDocsPayload({
          found: true,
          page: { ...header, intro: page.intro, sections: page.sections.map((section) => ({ ...section })) },
        });
      },
    }),
  },
];
