import { describe, expect, it, vi } from "vitest";

import {
  SLACK_MAX_MARKDOWN_TEXT_LENGTH,
  postSlackMarkdown,
  splitSlackMarkdownText,
  type SlackPostMessagePort,
} from "../../../src/modules/slack/delivery/slackDelivery.js";

const makeClient = () => {
  const calls: Array<Parameters<SlackPostMessagePort["postMessage"]>[0]> = [];
  const client: SlackPostMessagePort = {
    postMessage: vi.fn(async (input) => {
      calls.push(input);
      return { channel: input.channel, ts: `ts-${calls.length}` };
    }),
  };
  return { client, calls };
};

describe("postSlackMarkdown", () => {
  it("posts a short answer as a single markdown message in the thread", async () => {
    const { client, calls } = makeClient();

    const results = await postSlackMarkdown(client, {
      channel: "C1",
      markdownText: "**bold** and [a link](https://example.com)",
      threadTs: "1.0",
    });

    expect(calls).toEqual([
      { channel: "C1", markdownText: "**bold** and [a link](https://example.com)", threadTs: "1.0" },
    ]);
    expect(results).toEqual([{ channel: "C1", ts: "ts-1" }]);
  });

  it("chunks at the markdown_text limit and keeps every chunk in the same thread", async () => {
    const { client, calls } = makeClient();
    const markdownText = `${"a".repeat(SLACK_MAX_MARKDOWN_TEXT_LENGTH)}tail`;

    await postSlackMarkdown(client, { channel: "C1", markdownText, threadTs: "1.0" });

    expect(SLACK_MAX_MARKDOWN_TEXT_LENGTH).toBe(12_000);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => ("markdownText" in call ? call.markdownText.length : -1))).toEqual([
      SLACK_MAX_MARKDOWN_TEXT_LENGTH,
      4,
    ]);
    expect(calls.every((call) => call.threadTs === "1.0" && !("text" in call))).toBe(true);
  });
});

describe("splitSlackMarkdownText", () => {
  it("returns short markdown untouched", () => {
    expect(splitSlackMarkdownText("**bold**\n\nmore", 100)).toEqual(["**bold**\n\nmore"]);
  });

  it("breaks at the last paragraph boundary before the limit so spans and fences stay whole", () => {
    const first = "```js\nconst a = 1;\n```";
    const second = "Some **bold** text and a [link](https://example.com).";
    const third = "Tail paragraph.";
    const text = `${first}\n\n${second}\n\n${third}`;

    expect(splitSlackMarkdownText(text, first.length + 2 + second.length + 5)).toEqual([
      `${first}\n\n${second}`,
      third,
    ]);
    expect(splitSlackMarkdownText(text, second.length + 1)).toEqual([first, second, third]);
  });

  it("falls back to the last line break, then to a hard cut", () => {
    expect(splitSlackMarkdownText("line one\nline two\nline three", 18)).toEqual(["line one\nline two", "line three"]);
    expect(splitSlackMarkdownText("a".repeat(25), 10)).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
  });

  it("never emits a chunk over the limit and never loses content", () => {
    const paragraphs = Array.from({ length: 40 }, (_, index) => `Paragraph ${index} ${"word ".repeat(index % 7)}`.trim());
    const text = paragraphs.join("\n\n");
    const chunks = splitSlackMarkdownText(text, 120);

    expect(chunks.every((chunk) => chunk.length <= 120 && chunk.length > 0)).toBe(true);
    expect(chunks.join("\n\n")).toBe(text);
  });
});
