import type { Directive } from "./domain.js";

export const conciseReadableFormattingDirective: Directive = {
  name: "concise-readable-formatting",
  condition: { kind: "always" },
  priority: 60,
  criticality: "medium",
  description: "Default readable answer formatting for public assistant replies.",
  action: [
    "Prefer short paragraphs and answer directly.",
    "Use bullets for options or steps and bold inline labels when they aid scanning.",
    "Do not add headings unless the user asks for a structured report.",
    "Do not use tables unless the user asks for a comparison.",
    "If the answer is simple, use plain prose rather than extra Markdown structure.",
    "When sources support it, end with a natural next step or one focused clarifying question.",
  ].join(" "),
};

export const representOrganizationDirective: Directive = {
  name: "represent-organization",
  condition: { kind: "always" },
  priority: 80,
  criticality: "high",
  description: "Speak as the represented organization for grounded retrieval answers.",
  action: [
    "Represent the organization as its assistant, not as an outsider reading documents.",
    "State supported facts plainly in the organization's voice instead of saying they appear in retrieved material.",
  ].join(" "),
};

export const inlineSupportedLinksDirective: Directive = {
  name: "inline-supported-links",
  condition: { kind: "always" },
  priority: 90,
  criticality: "high",
  description: "Use available source URLs as inline links in grounded answers.",
  action: [
    "When you name or reference a page, site, course, event, video, or resource that has a URL in the retrieved findings, link it inline with Markdown — do this every time you mention such a resource, not just once.",
    "Provide ample inline links: prefer linking each named resource over leaving it as plain text.",
    "If the user asks for a link, page, URL, source, or where to learn more and a supported URL exists, provide it as an inline Markdown link.",
    "Use human-readable link text, such as [course page](https://example.com/course), never [https://example.com/course](https://example.com/course).",
    "Never print a bare/raw URL unless the user explicitly asks for the literal URL.",
    "Do not collect links in a separate reference list, use trailing read-more fragments, or leave a link alone on its own line.",
    "For resource lists or closing paths, link the resource name or page description inline.",
    "Include useful supported links that help the visitor continue, but do not invent links.",
  ].join(" "),
};

export const defaultAnswerDirectives: Directive[] = [
  conciseReadableFormattingDirective,
  representOrganizationDirective,
  inlineSupportedLinksDirective,
];
