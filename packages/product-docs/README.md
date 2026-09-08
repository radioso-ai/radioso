# @radioso/product-docs

Radioso's published documentation, compiled into the product so Ray and the MCP
server can read it. Ray answers "how does Radioso work" from the same pages a
reader sees at [docs.radioso.ai](https://docs.radioso.ai), and an MCP client gets
them through `radioso_docs` and `radioso_doc_page`.

## Why the corpus is committed

The pages are compiled from `docs-portal/content/**/*.mdx` into
`src/generated/corpus.json`, which is checked in.

That artifact travels with the build, which is what makes the answers trustworthy.
An operator running a release from three months ago is told how *that* release
works, and an instance answers documentation questions on its own — the question
text stays inside it, and the answer arrives whether or not the instance can reach
anything else. It also keeps the image self-contained: neither the backend nor the
MCP build stage copies `docs-portal/`.

## Keeping it current

```bash
pnpm --filter @radioso/product-docs run sync         # recompile after editing the portal
pnpm --filter @radioso/product-docs run sync:check   # fail if the artifact is stale
```

The CI docs job runs `sync:check` on every `docs-portal/` change, and the backend
contract suite runs it too, so a portal edit that skips the resync fails the build.

MDX flattening, link rewriting, and slug derivation come from
`@radioso/docs-importer`, which already owns them for the hosted self-docs
workspace. One converter means the text Ray reads, the text an MCP client reads,
and the text the hosted agent answers from are the same text. That package is a
dev dependency: the corpus is committed, so nothing here reaches a runtime image.

## Reading it

```ts
import { listProductDocs, readProductDoc, readProductDocSection } from "@radioso/product-docs"

listProductDocs()                                        // slug, title, description, section headings
readProductDoc("guides/mcp-server")                      // intro plus every section
readProductDoc("https://docs.radioso.ai/guides/mcp-server")  // the page's own URL resolves too
readProductDocSection("operators/copilot", "review-proposals")
```

Each page carries its absolute published URL, so a caller can cite the page it
used. A section is addressable by its id or its heading text, which is how a long
page is read a part at a time.
