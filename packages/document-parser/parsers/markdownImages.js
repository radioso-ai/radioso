import { readMarkdownContent } from "./markdown.js";

/** `![alt](address "title")`: the inline image syntax, with an optional title in either quote. */
const INLINE_IMAGE = /!\[([^\]\n]*)\]\(\s*<?([^\s<>()]+)>?(?:\s+(?:"([^"\n]*)"|'([^'\n]*)'))?\s*\)/g;
/** A fence opens and closes a code block: three or more backticks or tildes, indented at most three spaces. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** An inline code span: a run of backticks, its text, and a run of the same length. */
const CODE_SPAN = /(`+)[^`]*?\1/g;
const ABSOLUTE_HTTP = /^https?:\/\//i;

/** The ranges of `content` that are code, fenced or inline, where image syntax is text. */
const codeRanges = (content) => {
  const ranges = [];
  let offset = 0;
  let fence = null;
  for (const line of content.split("\n")) {
    const opening = FENCE.exec(line)?.[1];
    if (fence) {
      ranges.push([offset, offset + line.length]);
      if (opening && opening[0] === fence[0] && opening.length >= fence.length) fence = null;
    } else if (opening) {
      fence = opening;
      ranges.push([offset, offset + line.length]);
    } else {
      for (const span of line.matchAll(CODE_SPAN)) ranges.push([offset + span.index, offset + span.index + span[0].length]);
    }
    offset += line.length + 1;
  }
  return ranges;
};

/**
 * The images a markdown file links with `![alt](https://…)`, in order, each with its alt text, its
 * title as the caption, and the offset of the image in the file's text. Only absolute http(s)
 * addresses are kept: a `data:` URI or a relative path names nothing that can be fetched. Image
 * syntax inside code is text, not an image.
 */
export const extractMarkdownImages = async ({ buffer, limits }) => {
  const text = readMarkdownContent(buffer);
  const code = codeRanges(text);
  const inCode = (index) => code.some(([start, end]) => index >= start && index < end);
  const images = [];
  let truncated = false;
  for (const match of text.matchAll(INLINE_IMAGE)) {
    const [, alt, url, doubleQuoted, singleQuoted] = match;
    if (!ABSOLUTE_HTTP.test(url) || inCode(match.index)) continue;
    if (images.length >= limits.maxImages) {
      truncated = true;
      break;
    }
    const title = (doubleQuoted ?? singleQuoted ?? "").trim();
    images.push({ kind: "linked", url, alt: alt.trim(), caption: title || null, offset: match.index });
  }
  return { text, images, truncated };
};
