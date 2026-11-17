---
title: "Chunking Strategy"
description: "Overview of chunking methods (fixed window, semantic, recursive text) and when to use each for document splitting before retrieval."
last_updated: 2026-11-17
---

# Chunking Strategy

## Summary
Choose how newly ingested documents are split before they enter retrieval.

## Details
### Overview

Before the system can search documents, it has to divide them into chunks. This setting determines how that segmentation is performed.

### Why It Matters

The model does not usually retrieve an entire document.

It retrieves chunks.

So if chunking is bad:

- search can miss the right evidence
- answers can sound fragmented
- citations can point at awkward slices of text

If chunking is good:

- search gets cleaner evidence
- answers feel more grounded
- citations look more natural

### Available Strategies

#### Fixed window

This cuts text into slices of at most the chunk size. Each slice ends at the last sentence or line end that keeps it at least half full; when a single sentence runs past that, the slice ends between two words instead. Only one unbroken string longer than a whole chunk, such as a very long URL, is cut where the chunk runs out. The boundaries come from Unicode text segmentation, so they hold for languages written without spaces, such as Chinese or Japanese, and a Markdown heading stays with the section below it.

Use it when:

- documents are mostly plain text
- you want predictable chunk sizes
- formatting is weak or unreliable

#### Semantic

This uses embedding similarity over sentence windows to find natural topic boundaries.

The stored setting value is `structured_semantic` for compatibility with existing workspaces.

Use it when:

- documents are mostly prose
- topic shifts matter more than exact character counts
- you want boundaries based on semantic changes in the text

#### Recursive text

This uses text boundaries before falling back to smaller splits:

- paragraphs
- sentences
- punctuation
- words
- characters

Use it when:

- documents are mostly prose with clear paragraphs
- you want each chunk to hold whole paragraphs where they fit

### Tradeoffs

Fixed window is simpler and more predictable.

Semantic chunking is often more natural for prose, but it depends on embeddings during ingestion.

Recursive text is a practical middle option. It does not use embeddings, and it keeps paragraphs together before it splits them.

### Tables And Code

Recursive text and semantic chunking handle tables and code before the selected prose strategy runs.

Markdown and HTML tables are split with repeated table headers so each chunk keeps column context. Fenced code blocks and source-code documents are routed through code-aware chunking when the runtime has parser support for the detected language. If a code parser is unavailable, ingestion falls back to the selected text strategy.

Fixed window chunking reads tables and code as text. Its chunks end at line ends, and the overlap repeats whole rows and lines or none, so a table row or a line of code stays whole. A chunk does not repeat the table's header row.

Code-aware chunking is attempted for source documents and fenced code blocks with these language hints or file extensions:

- Bash, shell, Fish, and Zsh
- C, C++, C headers, and C#
- CSS, SCSS, and Less
- Go
- Java
- JavaScript, JSX, JSON, TypeScript, and TSX
- Kotlin
- PHP
- Python
- Ruby
- Rust
- Scala
- SQL
- Swift
- TOML
- XML
- YAML and YML

### Facts At The Top Of A Document

Whichever strategy you choose, every chunk carries the facts its document states at the top: YAML front matter, or two or more `Label: value` lines right under the title, such as `Region: Umbria` and `Type: Farmhouse`. Bullets and bold labels are fine. Each chunk is searched with those facts, and the agent sees them beside the chunk, so a passage from the end of a long description still answers "which region is it in?".

A block counts when each label appears once, each value is a short field rather than a sentence, and a blank line or a heading separates it from the text below. An FAQ, a transcript, email headers, a glossary of definitions, numbered steps, and indented code don't count. The block ends at the first line that is not a field, and the fields before that line still count.

A chunk stores up to 24 facts. Its search text gives them at most 30% of the chunk's own length, short fields first, after the chunk's text. The agent sees up to 200 characters of them per passage.

### When To Revisit

Revisit chunking strategy if:

- retrieval finds vaguely related text but not the right passage
- citations feel too narrow or too broad
- answers seem to miss context that obviously exists nearby in the source
