import { describe, expect, it } from "vitest";

import { FixedWindowChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/fixedWindowChunkingStrategy.js";
import { renderSearchText } from "../../src/modules/retrieval/services/searchTextRenderer.js";
import {
  deriveChunkHeadings,
  deriveChunkSection,
  deriveDocumentSubject,
} from "../../src/modules/retrieval/services/subjectIdentityService.js";
import { defaultIngestionSettings } from "../../src/modules/settings/domain/ingestionSettings.js";
import { RETRIEVAL_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";
import { sectionedPageDocuments } from "../fixtures/conversation-quality/sectionedPageCases.js";

describe("chunk section label", () => {
  it("names every section a chunk holds, in order", () => {
    const content = [
      "### Satellite",
      "",
      "Satellite costs €149 a month.",
      "",
      "### Planet",
      "",
      "Planet costs €579 a month.",
    ].join("\n");

    expect(deriveChunkSection(content)).toBe("Satellite · Planet");
  });

  it("lists every heading a chunk holds once, past the label's length cap too", () => {
    const longHeading = "A heading long enough to take the section label past its cap of characters";
    const content = ["### Satellite", "", "### Planet", "", `### ${longHeading}`, "", "### Planet"].join("\n");

    expect(deriveChunkHeadings(content)).toEqual(["Satellite", "Planet", longHeading]);
    expect(deriveChunkSection(content)).toBe("Satellite · Planet");
  });

  it("lists each heading as written, so a reader can tell where its name ends, while the label normalizes it", () => {
    const content = ["### Planet (Most popular)", "", "Planet costs €579 a month.", "", "### Comet - for teams"].join("\n");

    expect(deriveChunkHeadings(content)).toEqual(["Planet (Most popular)", "Comet - for teams"]);
    expect(deriveChunkSection(content)).toBe("Planet Most popular · Comet");
  });

  it("keeps a one-section chunk's label as its heading", () => {
    expect(deriveChunkSection("## Planet\n\nPlanet costs €579 a month.")).toBe("Planet");
  });

  it("gives a chunk without a heading no label", () => {
    expect(deriveChunkSection("Planet costs €579 a month.")).toBeNull();
  });

  it("names a repeated heading once", () => {
    expect(deriveChunkSection("## Planet\n\nIntro.\n\n## Planet\n\nMore.")).toBe("Planet");
  });

  it("stops at whole headings so the label stays short", () => {
    const headings = Array.from({ length: 12 }, (_, index) => `Section number ${index + 1} of the page`);
    const content = headings.map((heading) => `### ${heading}\n\nText.`).join("\n\n");

    const label = deriveChunkSection(content);

    expect(label).not.toBeNull();
    const parts = (label ?? "").split(" · ");
    expect(parts).toEqual(headings.slice(0, parts.length));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThan(headings.length);
    expect((label ?? "").length).toBeLessThanOrEqual(80);
  });

  it("labels the sectioned page's chunk that states a later plan's price with that plan, within the reranker's view (#1876)", async () => {
    const page = sectionedPageDocuments[0];
    const chunks = await new FixedWindowChunkingStrategy().chunk({
      title: page.title,
      content: page.content,
      config: defaultIngestionSettings("workspace-1"),
    });
    const answering = chunks.find((chunk) => chunk.content.includes("Planet costs €579"));
    expect(answering).toBeDefined();
    const content = answering?.content ?? "";

    const sectionPath = deriveChunkSection(content);
    const rerankView = renderSearchText({
      title: page.title,
      subjectLabel: deriveDocumentSubject({ title: page.title, content: page.content }),
      sectionPath,
      content,
    }).slice(0, RETRIEVAL_BEHAVIOR.rerank.maxRetrievalTextChars);

    expect(sectionPath?.split(" · ")).toContain("Planet");
    expect(rerankView).toContain("Planet");
    expect(rerankView).toContain(content.replace(/\s+/g, " ").trim().slice(0, 40));
  });
});
