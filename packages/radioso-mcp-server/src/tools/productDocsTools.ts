import { listProductDocs, readProductDoc, readProductDocSection } from "@radioso/product-docs";
import { z } from "zod";

import type { GenericToolDefinition } from "./common.js";

/**
 * Radioso's own documentation, served next to `ask_agent`.
 *
 * A client wired to this server is usually being used to build or operate against Radioso, so the
 * questions it asks are as often "how does this work" as "what does my agent say". Answering the
 * first from the corpus compiled into this build keeps the answer matched to the release the
 * caller is actually talking to, and needs no converse session: the documentation is public and
 * identical for every workspace on this deployment.
 */
/** A page over this length is returned as an outline; its sections are read one at a time. */
const PAGE_INLINE_CHAR_BUDGET = 18_000;

const pageArgsSchema = z.object({
  slug: z.string().trim().min(1).max(200),
  section: z.string().trim().min(1).max(200).optional(),
});

export const createProductDocsToolDefinitions = (): GenericToolDefinition[] => [
  {
    description:
      "List every page of Radioso's product documentation with its slug, summary, and section "
      + "headings. Use this to find the page that explains a Radioso concept, setting, or API "
      + "before reading it with radioso_doc_page. This is Radioso's own manual, not the documents "
      + "a workspace has ingested — ask_agent answers from those.",
    execute: async () => {
      const pages = listProductDocs().map((page) => ({
        slug: page.slug,
        title: page.title,
        description: page.description,
        section: page.section,
        url: page.url,
        headings: [...page.headings],
        lastUpdated: page.lastUpdated,
      }));

      return {
        data: { pageCount: pages.length, pages },
        summary: `${pages.length} Radioso documentation pages.`,
      };
    },
    inputSchema: z.object({}),
    name: "radioso_docs",
  },
  {
    description:
      "Read one page of Radioso's product documentation by slug — for example `guides/mcp-server` "
      + "— or one section of it. Slugs come from radioso_docs. Use this to ground an explanation "
      + "of how Radioso works in the documentation shipped with this release.",
    execute: async (args) => {
      const parsed = pageArgsSchema.parse(args);
      const page = readProductDoc(parsed.slug);
      if (!page) {
        return {
          data: { found: false, availableSlugs: listProductDocs().map((summary) => summary.slug) },
          summary: `No Radioso documentation page has the slug "${parsed.slug}".`,
        };
      }

      const header = {
        slug: page.slug,
        title: page.title,
        description: page.description,
        url: page.url,
        lastUpdated: page.lastUpdated,
      };

      if (parsed.section) {
        const section = readProductDocSection(page.slug, parsed.section);
        if (!section) {
          return {
            data: { found: false, availableSections: page.sections.map((candidate) => candidate.id) },
            summary: `"${page.title}" has no section "${parsed.section}".`,
          };
        }
        return {
          data: { found: true, page: { ...header, intro: "", sections: [{ ...section }] } },
          summary: `${page.title} — ${section.heading}`,
        };
      }

      // A long page returns its outline rather than a clipped body, so a caller acting on a
      // procedure always has the whole procedure.
      const inlineLength = page.intro.length
        + page.sections.reduce((total, section) => total + section.heading.length + section.body.length, 0);
      if (inlineLength > PAGE_INLINE_CHAR_BUDGET) {
        return {
          data: {
            found: true,
            page: {
              ...header,
              intro: page.intro,
              sections: [],
              sectionsOmitted: page.sections.map(({ id, heading }) => ({ id, heading })),
            },
          },
          summary: `${page.title} is long; read a section by passing its id to radioso_doc_page.`,
        };
      }

      return {
        data: {
          found: true,
          page: { ...header, intro: page.intro, sections: page.sections.map((section) => ({ ...section })) },
        },
        summary: page.title,
      };
    },
    inputSchema: pageArgsSchema,
    name: "radioso_doc_page",
  },
];
