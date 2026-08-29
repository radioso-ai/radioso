/**
 * Strips inline markdown syntax from a short preview string (a conversation
 * title, a search query snippet, ...) so it reads as plain text in a table
 * row. This is structural markdown-format parsing, not product-vocabulary
 * matching, so plain regexes are appropriate here.
 *
 * Only inline constructs are handled — links, emphasis, and inline code —
 * since preview strings are single-line snippets, never block-level markdown
 * (headings, lists, code fences).
 */
export function stripMarkdownSyntax(text: string): string {
  if (!text) {
    return text
  }

  let result = text

  // Links: [text](url) -> text
  result = result.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // Bold: **text** or __text__ -> text (must run before the single-marker
  // emphasis patterns below, since those would otherwise match half of a
  // bold marker pair first).
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1')
  result = result.replace(/__([^_]+)__/g, '$1')
  // Italic: *text* or _text_ -> text
  result = result.replace(/\*([^*]+)\*/g, '$1')
  result = result.replace(/_([^_]+)_/g, '$1')
  // Inline code: `code` -> code
  result = result.replace(/`([^`]+)`/g, '$1')

  return result
}
