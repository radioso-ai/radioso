import { readMarkdownContent } from "./markdown.js";

/**
 * `![alt](address "title")`: the inline image syntax, with an optional title in either quote.
 * Every part has a bound, so a line of unclosed `![` costs a fixed amount per start, never the
 * rest of the line.
 */
const INLINE_IMAGE = /!\[([^\]\n]{0,300})\]\([ \t]{0,8}<?([^\s<>()]{1,2048})>?(?:[ \t]{1,8}(?:"([^"\n]{0,500})"|'([^'\n]{0,500})'))?[ \t]{0,8}\)/g;
/** A fence opens and closes a code block: three or more backticks or tildes, indented at most three spaces. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ABSOLUTE_HTTP = /^https?:\/\//i;

/**
 * A line's inline code spans: a run of backticks up to the next run of the same length. Each
 * length keeps a cursor into the runs of that length, so the line is read once however many
 * runs go unclosed.
 */
const codeSpans = (line, offset) => {
  const runs = [];
  for (let index = 0; index < line.length;) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    const start = index;
    while (line[index] === "`") index += 1;
    runs.push({ start, end: index, length: index - start });
  }
  const byLength = new Map();
  runs.forEach((run, index) => {
    if (!byLength.has(run.length)) byLength.set(run.length, { runs: [], cursor: 0 });
    byLength.get(run.length).runs.push(index);
  });
  const spans = [];
  for (let index = 0; index < runs.length;) {
    const same = byLength.get(runs[index].length);
    while (same.cursor < same.runs.length && same.runs[same.cursor] <= index) same.cursor += 1;
    const closing = same.runs[same.cursor];
    if (closing === undefined) {
      index += 1;
      continue;
    }
    spans.push([offset + runs[index].start, offset + runs[closing].end]);
    index = closing + 1;
  }
  return spans;
};

/** The ranges of `content` that are code, fenced or inline, where image syntax is text; in order. */
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
      ranges.push(...codeSpans(line, offset));
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
  let range = 0;
  // Matches and ranges both come in document order, so one cursor walks the ranges once.
  const inCode = (index) => {
    while (range < code.length && code[range][1] <= index) range += 1;
    return range < code.length && code[range][0] <= index;
  };
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
