// BCP 47 primary subtags are 1-8 ASCII letters; this is a structural format check, not a
// language allowlist.
const PRIMARY_LANGUAGE_SUBTAG_PATTERN = /^[a-zA-Z]{1,8}$/;

/**
 * The primary tag of an `Accept-Language` header value: the first language-range, its
 * quality/`;`-parameters stripped, then only its primary subtag (before the first `-`).
 * `"de-DE,de;q=0.9"` -> `"de"`. Structural parsing only; a malformed or empty header
 * (or a primary subtag that is not 1-8 letters) resolves to `null` rather than throwing.
 *
 * Shared, pure, and framework-neutral so both the context-variables module (spec 1277
 * FR-031, `visitor_request`) and the visitors module (`visitors.last_language`) can
 * derive the same parsed tag without depending on each other.
 */
export const primaryLanguageTag = (acceptLanguage: string | null | undefined): string | null => {
  if (typeof acceptLanguage !== "string") {
    return null;
  }
  const firstRange = acceptLanguage.split(",")[0]?.trim();
  if (!firstRange) {
    return null;
  }
  const withoutQuality = firstRange.split(";")[0]?.trim();
  if (!withoutQuality) {
    return null;
  }
  const primary = withoutQuality.split("-")[0]?.trim();
  if (!primary || !PRIMARY_LANGUAGE_SUBTAG_PATTERN.test(primary)) {
    return null;
  }
  return primary.toLowerCase();
};
