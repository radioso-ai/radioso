import { describe, expect, it, vi } from "vitest";

import { ChonkieChunkingProvider } from "../../src/modules/retrieval/infra/chonkieChunkingProvider.js";
import { FixedWindowChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/fixedWindowChunkingStrategy.js";
import { RecursiveTextChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/recursiveTextChunkingStrategy.js";
import { StructuredSemanticChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/structuredSemanticChunkingStrategy.js";
import type { TextChunkingProviderPort } from "../../src/modules/retrieval/domain/chunking/chunkingProvider.js";

const defaultChunkingConfig = {
  fixedWindowChunkSize: 40,
  fixedWindowChunkOverlap: 8,
  structuredMinChunkSize: 8,
  structuredMaxChunkSize: 220,
};

describe("provider-backed chunking", () => {
  it("delegates fixed-window chunking through the configured provider", async () => {
    const provider: TextChunkingProviderPort = {
      name: "test-provider",
      chunkText: vi.fn().mockResolvedValue([
        {
          content: "Alpha bravo",
          startOffset: 0,
          endOffset: 11,
        },
      ]),
    };
    const strategy = new FixedWindowChunkingStrategy(provider);

    const chunks = await strategy.chunk({
      title: "Provider backed",
      content: "Alpha bravo",
      config: defaultChunkingConfig,
    });

    expect(provider.chunkText).toHaveBeenCalledWith({
      method: "fixed_window",
      title: "Provider backed",
      content: "Alpha bravo",
      chunkSize: 40,
      chunkOverlap: 8,
    });
    expect(chunks).toEqual([
      {
        chunkIndex: 0,
        content: "Alpha bravo",
        startOffset: 0,
        endOffset: 11,
      },
    ]);
  });

  it("delegates recursive text chunking through the configured provider", async () => {
    const provider: TextChunkingProviderPort = {
      name: "test-provider",
      chunkText: vi.fn().mockResolvedValue([
        {
          content: "Alpha bravo.",
          startOffset: 0,
          endOffset: 12,
        },
        {
          content: " Charlie delta.",
          startOffset: 12,
          endOffset: 27,
        },
      ]),
    };
    const strategy = new RecursiveTextChunkingStrategy(provider);

    const chunks = await strategy.chunk({
      title: "Provider backed",
      content: "Alpha bravo. Charlie delta.",
      config: defaultChunkingConfig,
    });

    expect(provider.chunkText).toHaveBeenCalledWith({
      method: "recursive",
      title: "Provider backed",
      content: "Alpha bravo. Charlie delta.",
      chunkSize: 40,
      minCharactersPerChunk: 8,
    });
    expect(chunks).toEqual([
      {
        chunkIndex: 0,
        content: "Alpha bravo.",
        startOffset: 0,
        endOffset: 12,
      },
      {
        chunkIndex: 1,
        content: "Charlie delta.",
        startOffset: 13,
        endOffset: 27,
      },
    ]);
  });

  it("delegates semantic chunking through the configured provider", async () => {
    const provider: TextChunkingProviderPort = {
      name: "test-provider",
      chunkText: vi.fn().mockResolvedValue([
        {
          content: "Alpha topic. Related detail.",
          startOffset: 0,
          endOffset: 28,
        },
      ]),
    };
    const strategy = new StructuredSemanticChunkingStrategy(provider);

    const chunks = await strategy.chunk({
      title: "Provider backed",
      content: "Alpha topic. Related detail.",
      config: defaultChunkingConfig,
    });

    expect(provider.chunkText).toHaveBeenCalledWith({
      method: "semantic",
      title: "Provider backed",
      content: "Alpha topic. Related detail.",
      chunkSize: 220,
      minCharactersPerChunk: 8,
    });
    expect(chunks).toEqual([
      {
        chunkIndex: 0,
        content: "Alpha topic. Related detail.",
        startOffset: 0,
        endOffset: 28,
      },
    ]);
  });

  it("uses ChonkieJS recursive chunking without splitting normal words mid-boundary", async () => {
    const provider = new ChonkieChunkingProvider();
    const chunks = await provider.chunkText({
      method: "recursive",
      content: "Alpha bravo charlie. Delta echo foxtrot. Golf hotel india.",
      chunkSize: 24,
      minCharactersPerChunk: 8,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content).toBe("Alpha bravo charlie. Delta echo foxtrot. Golf hotel india.".slice(
        chunk.startOffset,
        chunk.endOffset,
      ));
    }

    for (const chunk of chunks.slice(0, -1)) {
      const previousCharacter = chunk.content.at(-1) ?? "";
      const nextCharacter = "Alpha bravo charlie. Delta echo foxtrot. Golf hotel india."[chunk.endOffset] ?? "";

      expect(/[A-Za-z]/.test(previousCharacter) && /[A-Za-z]/.test(nextCharacter)).toBe(false);
    }
  });

  it("uses ChonkieJS token chunking for fixed windows", async () => {
    const provider = new ChonkieChunkingProvider();
    const chunks = await provider.chunkText({
      method: "fixed_window",
      content: "abcdefghijklmnopqrstuvwxyz",
      chunkSize: 10,
      chunkOverlap: 2,
    });

    expect(chunks.map((chunk) => chunk.content)).toEqual([
      "abcdefghij",
      "ijklmnopqr",
      "qrstuvwxyz",
      "yz",
    ]);
    expect(chunks[1]?.startOffset).toBe((chunks[0]?.endOffset ?? 0) - 2);
  });

  it("keeps fixed-window chunking independent from code and table specialized chunkers", async () => {
    const provider = new ChonkieChunkingProvider();
    const chunks = await provider.chunkText({
      method: "fixed_window",
      title: "math.ts",
      content: "abcdefghijklmnopqrstuvwxyz",
      chunkSize: 10,
      chunkOverlap: 2,
    });

    expect(chunks.map((chunk) => chunk.content)).toEqual([
      "abcdefghij",
      "ijklmnopqr",
      "qrstuvwxyz",
      "yz",
    ]);
    expect(chunks[1]?.startOffset).toBe(8);
  });

  it("drops fixed-window tail chunks that are fully contained in the previous chunk", async () => {
    const strategy = new FixedWindowChunkingStrategy(new ChonkieChunkingProvider());

    const chunks = await strategy.chunk({
      title: "Alphabet",
      content: "abcdefghijklmnopqrstuvwxyz",
      config: {
        ...defaultChunkingConfig,
        fixedWindowChunkSize: 10,
        fixedWindowChunkOverlap: 2,
      },
    });

    expect(chunks.map((chunk) => chunk.content)).toEqual([
      "abcdefghij",
      "ijklmnopqr",
      "qrstuvwxyz",
    ]);
  });

  it("uses ChonkieJS semantic chunking with the configured embedding provider", async () => {
    const content = "Alpha topic starts here. Alpha topic continues here. Beta topic starts here. Beta topic continues here.";
    const provider = new ChonkieChunkingProvider({
      async embedTexts(texts) {
        return texts.map((text) => text.includes("Beta") ? [0, 1] : [1, 0]);
      },
    });

    const chunks = await provider.chunkText({
      method: "semantic",
      content,
      chunkSize: 80,
      minCharactersPerChunk: 8,
    });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.content).toBe(content.slice(chunk.startOffset, chunk.endOffset));
    }
  });

  it("falls back to recursive chunking when semantic provider chunking fails", async () => {
    const provider: TextChunkingProviderPort = {
      name: "fallback-provider",
      chunkText: vi.fn()
        .mockRejectedValueOnce(new Error("embedding unavailable"))
        .mockResolvedValueOnce([
          {
            content: "Alpha section.",
            startOffset: 0,
            endOffset: 14,
          },
          {
            content: " Beta section.",
            startOffset: 14,
            endOffset: 28,
          },
        ]),
    };
    const strategy = new StructuredSemanticChunkingStrategy(provider);

    const chunks = await strategy.chunk({
      title: "Fallback",
      content: "Alpha section. Beta section.",
      config: defaultChunkingConfig,
    });

    expect(provider.chunkText).toHaveBeenNthCalledWith(1, {
      method: "semantic",
      title: "Fallback",
      content: "Alpha section. Beta section.",
      chunkSize: 220,
      minCharactersPerChunk: 8,
    });
    expect(provider.chunkText).toHaveBeenNthCalledWith(2, {
      method: "recursive",
      title: "Fallback",
      content: "Alpha section. Beta section.",
      chunkSize: 220,
      minCharactersPerChunk: 8,
    });
    expect(chunks).toEqual([
      {
        chunkIndex: 0,
        content: "Alpha section.",
        startOffset: 0,
        endOffset: 14,
      },
      {
        chunkIndex: 1,
        content: "Beta section.",
        startOffset: 15,
        endOffset: 28,
      },
    ]);
  });

  it("preserves markdown heading sections when semantic chunking would collapse a short document", async () => {
    const content = `# Intro

Welcome to Hivec.

- Open Settings
- Choose a strategy

## FAQ

What changes now?

Only future ingests change.`;
    const provider = new ChonkieChunkingProvider({
      async embedTexts(texts) {
        return texts.map(() => [1, 0]);
      },
    });

    const chunks = await provider.chunkText({
      method: "semantic",
      content,
      chunkSize: 220,
      minCharactersPerChunk: 24,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      content: `# Intro

Welcome to Hivec.

- Open Settings
- Choose a strategy`,
      startOffset: 0,
    });
    expect(chunks[1]?.content).toBe(`## FAQ

What changes now?

Only future ingests change.`);
    expect(chunks[1]?.startOffset).toBe(content.indexOf("## FAQ"));
  });

  it("routes markdown tables through ChonkieJS table chunking", async () => {
    const content = `Intro paragraph.

| Name | Role |
| --- | --- |
| Ada | Eng |
| Lin | Ops |
| Max | Sales |

Closing paragraph.`;
    const provider = new ChonkieChunkingProvider();

    const chunks = await provider.chunkText({
      method: "recursive",
      content,
      chunkSize: 45,
      minCharactersPerChunk: 8,
    });

    const tableChunks = chunks.filter((chunk) => chunk.content.includes("| Name | Role |"));
    expect(tableChunks.length).toBeGreaterThan(1);
    expect(tableChunks.every((chunk) => chunk.content.includes("| --- | --- |"))).toBe(true);
    expect(tableChunks.some((chunk) => chunk.content.includes("| Ada | Eng |"))).toBe(true);
    expect(tableChunks.every((chunk) => chunk.startOffset >= content.indexOf("| Ada | Eng |"))).toBe(true);
  });

  it("preserves repeated table headers after strategy chunk normalization", async () => {
    const strategy = new RecursiveTextChunkingStrategy(new ChonkieChunkingProvider());
    const content = `| Name | Role |
| --- | --- |
| Ada | Eng |
| Lin | Ops |
| Max | Sales |`;

    const chunks = await strategy.chunk({
      title: "Table",
      content,
      config: {
        ...defaultChunkingConfig,
        fixedWindowChunkSize: 45,
      },
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.includes("| Name | Role |"))).toBe(true);
    expect(chunks.every((chunk) => chunk.content.includes("| --- | --- |"))).toBe(true);
  });

  it("routes source-code documents through ChonkieJS code chunking based on title", async () => {
    const provider = new ChonkieChunkingProvider();
    const content = `export function add(left: number, right: number) {
  return left + right;
}

export function subtract(left: number, right: number) {
  return left - right;
}`;

    const chunks = await provider.chunkText({
      method: "recursive",
      title: "math.ts",
      content,
      chunkSize: 45,
      minCharactersPerChunk: 8,
    });

    expect(chunks.some((chunk) => chunk.content.includes("function add"))).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes("function subtract"))).toBe(true);
  });

  it("routes fenced code through ChonkieJS code chunking when language support is available", async () => {
    const content = `Intro paragraph.

\`\`\`js
function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}
\`\`\`

Closing paragraph.`;
    const provider = new ChonkieChunkingProvider();

    const chunks = await provider.chunkText({
      method: "recursive",
      content,
      chunkSize: 45,
      minCharactersPerChunk: 8,
    });

    expect(chunks.some((chunk) => chunk.content.includes("function add"))).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes("function subtract"))).toBe(true);
    expect(chunks.every((chunk) => !chunk.content.includes("```"))).toBe(true);
  });
});
