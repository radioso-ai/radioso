# Research: Safe Markdown Chat Answers

## Decision 1: Use `react-markdown` for assistant answer rendering

- **Decision**: Render assistant responses with `react-markdown` and a narrow component override layer.
- **Rationale**: It handles CommonMark formatting cleanly, keeps raw HTML disabled by default, and lets the UI own styling and link behavior without inventing a custom parser.
- **Alternatives considered**: Manual parsing was rejected because it would duplicate markdown rules and create more room for inconsistent rendering.

## Decision 2: Add `remark-breaks` to preserve answer line breaks

- **Decision**: Treat line breaks in assistant output as visible breaks during rendering.
- **Rationale**: The current plain-text renderer preserves line wrapping more naturally, and the chat experience should not lose that readability when markdown is introduced.
- **Alternatives considered**: Leaving markdown line breaks collapsed would make streamed answers harder to scan and would regress the current chat experience.

## Decision 3: Keep citations outside markdown syntax

- **Decision**: Continue to render citations as structured UI markers attached to answer segments.
- **Rationale**: Citations are provenance metadata, not formatting, and keeping them separate preserves open-document behavior and avoids making markdown responsible for trust semantics.
- **Alternatives considered**: Encoding citations in markdown or HTML was rejected because it would blur the boundary between user-visible formatting and source attribution.

## Decision 4: Block unsafe link targets in the renderer

- **Decision**: Accept only safe link targets for active anchors; render unsafe targets inertly.
- **Rationale**: Markdown links should remain useful, but they should not become a general-purpose navigation or script-injection channel.
- **Alternatives considered**: Trusting library defaults alone was considered too implicit for a chat surface that can display model-generated text.
