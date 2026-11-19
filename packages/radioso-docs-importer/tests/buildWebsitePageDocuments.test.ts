import { describe, expect, it } from "vitest";
import {
  buildWebsitePageDocuments,
  parseWebsitePageSpec,
  websitePageExternalId,
} from "../src/website/buildWebsitePageDocuments.ts";
import { syncDocuments } from "../src/import/sync.ts";
import type { DocumentInput } from "../src/import/buildDocuments.ts";
import type { ExistingDocument, RadiosoDocsClient } from "../src/radioso/client.ts";

const spec = { markdownUrl: "https://radioso.example/pricing.md", citationUrl: "https://radioso.example/pricing" };

function page(body: string, init: { ok?: boolean; status?: number } = {}) {
  return async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: "",
    text: async () => body,
  });
}

describe("parseWebsitePageSpec", () => {
  it("splits the markdown URL from the citation URL", () => {
    expect(parseWebsitePageSpec("https://radioso.example/pricing.md=https://radioso.example/pricing")).toEqual(spec);
  });

  it("rejects anything else", () => {
    expect(() => parseWebsitePageSpec("https://radioso.example/pricing.md")).toThrow(/Invalid --website-page/);
    expect(() => parseWebsitePageSpec("")).toThrow(/Invalid --website-page/);
  });
});

describe("buildWebsitePageDocuments", () => {
  const common = "https://docs.radioso.example";

  it("builds one document with the heading as title, the common source, and the citation URL", async () => {
    const documents = await buildWebsitePageDocuments([spec], common, page("Intro\n\n# Pricing\n\nPlanet is 579.   \n\n"));

    expect(documents).toEqual([
      {
        externalDocumentId: "radioso-website:/pricing",
        title: "Pricing",
        content: "Intro\n\n# Pricing\n\nPlanet is 579.",
        // The page's own origin would put it under a second source, which the
        // per-upsert prune deletes as a migration leftover.
        source: { kind: "website", url: common },
        metadata: { section: "radioso-website", url: "https://radioso.example/pricing" },
      },
    ]);
  });

  it("derives a stable id from the citation path", () => {
    expect(websitePageExternalId("https://radioso.example/pricing/")).toBe("radioso-website:/pricing");
    expect(websitePageExternalId("https://radioso.example")).toBe("radioso-website:/");
  });

  it("fails loudly on a non-2xx response", async () => {
    await expect(buildWebsitePageDocuments([spec], common, page("nope", { ok: false, status: 503 }))).rejects.toThrow(/503/);
  });

  it("fails loudly on a network error", async () => {
    const failing = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    await expect(buildWebsitePageDocuments([spec], common, failing)).rejects.toThrow(/ECONNREFUSED/);
  });

  it("fails on an empty page", async () => {
    await expect(buildWebsitePageDocuments([spec], common, page("  \n"))).rejects.toThrow(/empty/);
  });
});

describe("website page in a pruning sync", () => {
  // Like the backend: each distinct source URL gets its own source id.
  function sourceAwareClient() {
    const state: ExistingDocument[] = [];
    const deleted: string[] = [];
    const sourceIds = new Map<string, string>();
    const client: RadiosoDocsClient = {
      listAll: async () => [...state],
      create: async (input) => {
        const sourceId = sourceIds.get(input.source.url) ?? `source-${sourceIds.size + 1}`;
        sourceIds.set(input.source.url, sourceId);
        const id = `id-${input.externalDocumentId}`;
        if (!state.some((document) => document.id === id)) {
          state.push({ id, externalDocumentId: input.externalDocumentId, sourceId, metadata: input.metadata });
        }
        return { documentId: id, status: "queued" };
      },
      delete: async (id) => {
        deleted.push(id);
        state.splice(state.findIndex((document) => document.id === id), 1);
      },
      deleteSource: async () => {},
    };
    return { client, state, deleted };
  }

  it("keeps the page after the per-upsert prune", async () => {
    const common = "https://docs.radioso.example";
    const mdx: DocumentInput = {
      externalDocumentId: "mdx-docs:index",
      title: "Index",
      content: "body",
      source: { kind: "website", url: common },
      metadata: { section: "mdx-docs", slug: "index", url: `${common}/` },
    };
    const pages = await buildWebsitePageDocuments([spec], common, page("# Pricing\n\nPlanet is 579."));
    const { client, state, deleted } = sourceAwareClient();

    await syncDocuments(client, [mdx, ...pages], {
      prune: true,
      pruneSections: new Set(["mdx-docs", "radioso-website"]),
    });

    expect(deleted).toEqual([]);
    expect(state.map((document) => document.externalDocumentId)).toContain("radioso-website:/pricing");
  });
});
