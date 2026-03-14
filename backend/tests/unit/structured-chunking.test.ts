import { describe, expect, it } from "vitest";

import { parseStructuralBlocks } from "../../src/modules/retrieval/domain/chunking/structuredBlockParser.js";
import { StructuredSemanticChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/structuredSemanticChunkingStrategy.js";

describe("structured chunking", () => {
  it("parses deterministic structural blocks without english-specific heuristics", () => {
    const blocks = parseStructuralBlocks(`# Heading

Intro paragraph.

- Bullet one
- Bullet two

1. Step one
2. Step two

| Name | Value |
| --- | --- |
| Mode | Safe |

\`\`\`ts
const answer = 42
\`\`\`

What is Hivec?

It is a retrieval app.`);

    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "bullet_list",
      "ordered_list",
      "table",
      "code_fence",
      "faq_pair",
    ]);
  });

  it("does not close a 4-backtick fence on an inner triple-backtick example", () => {
    const blocks = parseStructuralBlocks(`\`\`\`\`md
\`\`\`ts
const answer = 42
\`\`\`
\`\`\`\`

After fence.`);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.kind).toBe("code_fence");
    expect(blocks[0]?.content).toContain("```ts");
    expect(blocks[0]?.content).toContain("const answer = 42");
    expect(blocks[1]?.kind).toBe("paragraph");
    expect(blocks[1]?.content).toBe("After fence.");
  });

  it("keeps wrapped and nested list content inside the same list block", () => {
    const blocks = parseStructuralBlocks(`- First item
  continuation line
  - Nested item
- Second item`);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("bullet_list");
    expect(blocks[0]?.content).toContain("continuation line");
    expect(blocks[0]?.content).toContain("- Nested item");
    expect(blocks[0]?.content).toContain("- Second item");
  });

  it("splits oversized structural units into bounded chunks while preserving order", async () => {
    const content = `# Guide

${"word ".repeat(600)}`.trim();
    const strategy = new StructuredSemanticChunkingStrategy({
      async embedTexts(texts) {
        return texts.map((_text, index) => [1, 0, index]);
      },
    });

    const chunks = await strategy.chunk({
      title: "Oversized",
      content,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length > 0)).toBe(true);
    expect(chunks[0].startOffset).toBe(0);
    expect(chunks.at(-1)?.endOffset).toBe(content.length);
  });

  it("falls back to deterministic structure-only chunking when semantic similarity is unavailable", async () => {
    const strategy = new StructuredSemanticChunkingStrategy({
      async embedTexts() {
        throw new Error("similarity unavailable");
      },
    });

    const chunks = await strategy.chunk({
      title: "Fallback",
      content: `# Topic A

Alpha detail.

## Topic B

Beta detail.`,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.content).toContain("Topic A");
    expect(chunks[1]?.content).toContain("Topic B");
  });
});
