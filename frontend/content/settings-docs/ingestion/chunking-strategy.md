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

#### Structured semantic

This tries to respect document shape first:

- headings
- paragraphs
- lists
- tables
- similar structural units

Use it when:

- formatting carries meaning
- you have policies, manuals, FAQs, exported docs, or rich text
- you want chunks to follow the way humans read the document

### Tradeoffs

Fixed window is simpler and more predictable.

Structured semantic is often more natural, but it depends more on document structure being usable.

### When To Revisit

Revisit chunking strategy if:

- retrieval finds vaguely related text but not the right passage
- citations feel too narrow or too broad
- answers seem to miss context that obviously exists nearby in the source
