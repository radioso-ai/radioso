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

This cuts text into evenly sized slices.

Use it when:

- documents are mostly plain text
- you want predictable behavior
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

- fixed window chunks are cutting words or sentences awkwardly
- documents are mostly prose
- you want a simple strategy that still respects natural text boundaries

### Tradeoffs

Fixed window is simpler and more predictable.

Semantic chunking is often more natural for prose, but it depends on embeddings during ingestion.

Recursive text is a practical middle option. It does not use embeddings, and it avoids many fixed-window boundary problems.

### Tables And Code

Recursive text and semantic chunking handle tables and code before the selected prose strategy runs.

Markdown and HTML tables are split with repeated table headers so each chunk keeps column context. Fenced code blocks and source-code documents are routed through code-aware chunking when the runtime has parser support for the detected language. If a code parser is unavailable, ingestion falls back to the selected text strategy.

Fixed window chunking stays fixed window for every input type. It does not use table-aware or code-aware chunking.

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

### When To Revisit

Revisit chunking strategy if:

- retrieval finds vaguely related text but not the right passage
- citations feel too narrow or too broad
- answers seem to miss context that obviously exists nearby in the source
