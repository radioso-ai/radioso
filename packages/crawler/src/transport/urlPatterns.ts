const REGEX_SPECIAL_CHARS = /[.+?^${}()|[\]\\]/g;

const globToRegExp = (pattern: string): RegExp => {
  const escaped = pattern.replace(REGEX_SPECIAL_CHARS, "\\$&");
  return new RegExp(escaped.replace(/\*+/g, ".*"));
};

// Patterns containing `*` are interpreted as globs (matched anywhere in the URL).
// Patterns without `*` use case-insensitive substring matching to preserve the
// historical behavior.
export const matchesUrlPattern = (url: string, patterns: string[] | undefined): boolean => {
  if (!patterns?.length) return false;
  const target = url.toLowerCase();
  return patterns.some((pattern) => {
    const lowered = pattern.toLowerCase();
    if (!lowered.includes("*")) {
      return target.includes(lowered);
    }
    try {
      return globToRegExp(lowered).test(target);
    } catch {
      return target.includes(lowered);
    }
  });
};
