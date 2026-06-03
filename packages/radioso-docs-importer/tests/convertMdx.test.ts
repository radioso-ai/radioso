import { describe, expect, it } from "vitest";
import { convertMdxDocument } from "../src/mdx/convertMdx.ts";

const CITATION_BASE = "https://docs.radioso.dev";

function convert(source: string, slug = "quickstarts/run-locally") {
  return convertMdxDocument(source, { slug, citationBase: CITATION_BASE });
}

describe("convertMdxDocument", () => {
  it("reads title and description from frontmatter", () => {
    const result = convert(`---
title: Run locally in 5 minutes
description: Start the full Radioso stack locally.
---

# Run locally

Body text.
`);
    expect(result.title).toBe("Run locally in 5 minutes");
    expect(result.description).toBe("Start the full Radioso stack locally.");
  });

  it("drops import/export statements from the output", () => {
    const result = convert(`---
title: T
---

import { Callout, Steps } from 'nextra/components'

Real paragraph.
`);
    expect(result.markdown).not.toContain("import {");
    expect(result.markdown).not.toContain("nextra/components");
    expect(result.markdown).toContain("Real paragraph.");
  });

  it("preserves text inside Callout components", () => {
    const result = convert(`---
title: T
---

<Callout type="info" emoji="↗">
  Choose one path first before continuing.
</Callout>
`);
    expect(result.markdown).toContain("Choose one path first before continuing.");
    expect(result.markdown).not.toContain("emoji");
    expect(result.markdown).not.toContain("<Callout");
  });

  it("preserves Card titles and descriptions and absolutizes their hrefs", () => {
    const result = convert(`---
title: T
---

<Cards num={3}>
  <Cards.Card title="Evaluate locally" href="/quickstarts/run-locally">
    Bring up the full stack with Docker.
  </Cards.Card>
</Cards>
`);
    expect(result.markdown).toContain("Evaluate locally");
    expect(result.markdown).toContain("Bring up the full stack with Docker.");
    expect(result.markdown).toContain("https://docs.radioso.dev/quickstarts/run-locally");
    expect(result.markdown).not.toContain("<Cards");
  });

  it("absolutizes root-relative markdown links against the citation base", () => {
    const result = convert(`---
title: T
---

See the [retrieval guide](/guides/retrieval-tuning) for details.
`);
    expect(result.markdown).toContain("https://docs.radioso.dev/guides/retrieval-tuning");
  });

  it("leaves absolute and anchor links untouched", () => {
    const result = convert(`---
title: T
---

External [site](https://example.com/x) and [anchor](#section).
`);
    expect(result.markdown).toContain("https://example.com/x");
    expect(result.markdown).toContain("(#section)");
  });

  it("keeps ordinary markdown: headings, lists, fenced code", () => {
    const result = convert(`---
title: T
---

## Prerequisites

- Node.js 24+
- Docker

\`\`\`bash
./run-dev.sh
\`\`\`
`);
    expect(result.markdown).toContain("## Prerequisites");
    expect(result.markdown).toContain("Node.js 24+");
    expect(result.markdown).toContain("./run-dev.sh");
  });
});
