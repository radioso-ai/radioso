const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

export const renderSearchText = (input: {
  title: string;
  subjectLabel?: string | null;
  sectionPath?: string | null;
  attributeText?: string | null;
  content: string;
}): string => {
  const parts = [
    input.title ? `Title: ${normalizeWhitespace(input.title)}` : "",
    input.subjectLabel ? `Subject: ${normalizeWhitespace(input.subjectLabel)}` : "",
    input.sectionPath ? `Section: ${normalizeWhitespace(input.sectionPath)}` : "",
    input.attributeText ? `Attributes: ${normalizeWhitespace(input.attributeText)}` : "",
    normalizeWhitespace(input.content),
  ].filter((part) => part.length > 0);

  return parts.join("\n\n");
};
