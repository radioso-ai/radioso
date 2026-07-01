import { describe, expect, it } from "vitest";

import { loadPromptTemplate } from "../../src/shared/infra/prompts/promptLoader.js";

describe("grounded answer prompt contract", () => {
  it("requires parseable source anchors for backend citation validation", () => {
    const prompt = loadPromptTemplate("retrieval/answer.md");

    expect(prompt).toContain("[[1]]");
    expect(prompt).toMatch(/append the internal source anchor/i);
    expect(prompt).toMatch(/grounded claim/i);
    expect(prompt).not.toMatch(/do not write citation markers/i);
    expect(prompt).not.toMatch(/application attaches source citations after generation/i);
  });

  it("keeps reusable answer behavior out of the base prompt so directives own it", () => {
    const prompt = loadPromptTemplate("retrieval/answer.md");

    expect(prompt).not.toContain("You are representing the organization");
    expect(prompt).not.toContain("Embed inline Markdown links directly in the answer");
    expect(prompt).not.toContain("Provide ample links");
  });

  it("limits inline links to named resources with explicit Source URLs", () => {
    const prompt = loadPromptTemplate("retrieval/answer.md");

    expect(prompt).toContain("has such a Source URL");
    expect(prompt).toContain("turn that resource's own name into an inline Markdown link to its Source URL");
    expect(prompt).toContain("Never invent a URL");
    expect(prompt).not.toContain("source you draw the answer from");
    expect(prompt).not.toContain("leaving only a bare citation marker");
  });
});
