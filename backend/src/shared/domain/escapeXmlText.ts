/**
 * Escapes the three characters that could close or open a tag, so text framed inside an
 * XML-style prompt block (`<tag>…</tag>`) cannot forge the block's boundary. Used wherever
 * operator- or visitor-supplied text is wrapped in a delimiter tag the model is told to
 * treat as data.
 */
export const escapeXmlText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
