import { describe, expect, it } from "vitest";
import {
  buildWebsitePageDocuments,
  parseWebsitePageSpec,
  websitePageExternalId,
} from "../src/website/buildWebsitePageDocuments.ts";

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
  it("builds one document with the heading as title, the page origin as source, and the citation URL", async () => {
    const documents = await buildWebsitePageDocuments([spec], page("Intro\n\n# Pricing\n\nPlanet is 579.   \n\n"));

    expect(documents).toEqual([
      {
        externalDocumentId: "radioso-website:/pricing",
        title: "Pricing",
        content: "Intro\n\n# Pricing\n\nPlanet is 579.",
        source: { kind: "website", url: "https://radioso.example" },
        metadata: { section: "radioso-website", url: "https://radioso.example/pricing" },
      },
    ]);
  });

  it("derives a stable id from the citation path", () => {
    expect(websitePageExternalId("https://radioso.example/pricing/")).toBe("radioso-website:/pricing");
    expect(websitePageExternalId("https://radioso.example")).toBe("radioso-website:/");
  });

  it("fails loudly on a non-2xx response", async () => {
    await expect(buildWebsitePageDocuments([spec], page("nope", { ok: false, status: 503 }))).rejects.toThrow(/503/);
  });

  it("fails loudly on a network error", async () => {
    const failing = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    await expect(buildWebsitePageDocuments([spec], failing)).rejects.toThrow(/ECONNREFUSED/);
  });

  it("fails on an empty page", async () => {
    await expect(buildWebsitePageDocuments([spec], page("  \n"))).rejects.toThrow(/empty/);
  });
});
