const HTML_SENSITIVE_CHARACTERS: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
};

/**
 * Escapes characters that could let untrusted or model-generated content close the
 * `<...>` prompt envelope tags this module's prompt builders wrap around embedded
 * data. Shared across the naming and privacy-audit prompt builders so the escaping
 * rule lives in exactly one place.
 */
export const serializeUntrustedInput = (value: unknown): string =>
  JSON.stringify(value).replace(/[<>&]/g, (character) => HTML_SENSITIVE_CHARACTERS[character]);
