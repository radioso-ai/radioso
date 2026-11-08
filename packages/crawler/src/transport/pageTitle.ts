/**
 * A page title with whitespace runs (newlines, double spaces, no-break spaces) collapsed to one
 * space and the ends trimmed. Extraction produces this form and the change check compares through
 * it, so a title stored before extraction collapsed whitespace is not mistaken for a new one.
 */
export const normalizePageTitle = (value: string): string => value.replace(/\s+/g, " ").trim();
