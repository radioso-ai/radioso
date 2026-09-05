import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const topicCensusDocUrl = new URL(
  "../../../../docs/architecture/topic-census.md",
  import.meta.url,
);

describe("topic census architecture documentation", () => {
  it("states the complete narrative reuse and reservation rules", async () => {
    const markdown = await readFile(topicCensusDocUrl, "utf8");

    expect(markdown).toMatch(/stored recommendation evidence[^.]*exactly matches[^.]*ordered output/i);
    expect(markdown).toMatch(/reserve[^.]*before the census/i);
    expect(markdown).toMatch(/reuse[^.]*release[^.]*no model call/i);
    expect(markdown).toMatch(/facet[^.]*release[^.]*no model call/i);
  });
});
