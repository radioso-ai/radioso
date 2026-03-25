# Data Model: Safe Markdown Chat Answers

## Entities

### Assistant Answer

- **Represents**: A rendered assistant message shown in chat.
- **Attributes**: answer text, optional answer segments, optional citations, rendering state.
- **Relationships**: Contains zero or more answer segments and zero or more citations.

### Answer Segment

- **Represents**: A contiguous slice of assistant answer text that may carry one or more citations.
- **Attributes**: segment text, citation indices.
- **Relationships**: Belongs to exactly one assistant answer.

### Citation Marker

- **Represents**: A structured, clickable source reference displayed alongside an assistant answer.
- **Attributes**: document identity, chunk identity, display label.
- **Relationships**: Points to a source document and is attached to one answer segment.

### Supported Markdown Subset

- **Represents**: The formatting patterns the chat UI intentionally renders for assistant answers.
- **Attributes**: paragraphs, line breaks, emphasis, inline code, fenced code blocks, blockquotes, lists, links.
- **Relationships**: Applied to the plain answer text inside each answer segment.

## State Notes

- This feature does not introduce persistence changes.
- The only stateful behavior is client-side rendering of already-stored message text.
