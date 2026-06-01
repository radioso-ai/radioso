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
    "When you name or reference a page, site, course, event, video, or resource that has a URL in the retrieved findings, link it inline with Markdown by turning the resource's own name or description into the link, within the sentence that mentions it.",
    "Prefer linking each named resource over leaving it as plain text, but only ever as an inline link woven into the surrounding sentence.",
    "Never gather links into a trailing list, a closing line, a sources or read-more block, a run of links separated by semicolons or commas, or any group that follows a citation marker — even when several resources are relevant, link each one in place instead.",
    "Never leave a link, or a citation marker, alone on its own line.",
    "If the user asks for a link, page, URL, source, or where to learn more and a supported URL exists, provide it as an inline Markdown link.",
    "Use human-readable link text, such as [course page](https://example.com/course), never [https://example.com/course](https://example.com/course).",
    "Never print a bare/raw URL unless the user explicitly asks for the literal URL.",
    "Include useful supported links that help the visitor continue, but do not invent links.",
  ].join(" "),
};

export const defaultAnswerDirectives: Directive[] = [
  conciseReadableFormattingDirective,
  representOrganizationDirective,
  inlineSupportedLinksDirective,
];
