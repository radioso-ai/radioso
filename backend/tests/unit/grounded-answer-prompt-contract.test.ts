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
});
