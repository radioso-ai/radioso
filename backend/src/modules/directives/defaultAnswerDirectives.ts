import type { Directive } from "./domain.js";

export interface BuiltInDirectiveView {
  name: string;
  condition: Directive["condition"];
  action: string;
  priority: number | null;
  description: string | null;
}

export const conciseReadableFormattingDirective: Directive = {
  name: "concise-readable-formatting",
  condition: { kind: "always" },
  priority: 60,
  description: "Default readable answer formatting for public assistant replies.",
  action: [
    "Prefer short paragraphs and answer directly.",
    "Use bullets for options or steps and bold inline labels only when they aid scanning.",
    "Do not add headings unless the user asks for a structured report.",
    "Do not use tables unless the user asks for a comparison.",
    "Keep simple answers in plain prose.",
    "When supported and the turn remains open, end with one natural next step or focused question.",
  ].join(" "),
};

export const representOrganizationDirective: Directive = {
  name: "represent-organization",
  condition: { kind: "always" },
  priority: 80,
  description: "Speak as the represented organization for grounded retrieval answers.",
  action: "Speak as the organization, stating supported facts directly in its voice rather than as a report about retrieved material.",
};

export const inlineSupportedLinksDirective: Directive = {
  name: "inline-supported-links",
  condition: { kind: "always" },
  priority: 90,
  description: "Use available source URLs as inline links in grounded answers.",
  action: [
    "When a named page, site, course, event, video, or resource has a URL in the retrieved findings, link it inline with Markdown on the resource's own name, within the sentence that mentions it.",
    "Prefer linking each named resource. The link text must be the resource's own name as human-readable link text, not a generic pointer phrase such as 'here' or 'details'.",
    "If the user asks for a link or you direct them to open, use, register for, book, contact, download, or read a resource, include its supported inline link.",
    "Never invent a link. Never print a bare/raw URL unless the user explicitly requests the literal URL.",
    "Use the supported link; never substitute a citation marker or a parenthetical gesture.",
    "Never gather links into a trailing list, closing line, sources or read-more block, run separated by semicolons or commas, or group that follows a citation marker.",
    "Never leave a link or citation marker alone on its own line.",
  ].join(" "),
};

export const defaultAnswerDirectives: Directive[] = [
  conciseReadableFormattingDirective,
  representOrganizationDirective,
  inlineSupportedLinksDirective,
];

export const builtInAnswerDirectiveViews: BuiltInDirectiveView[] = defaultAnswerDirectives.map((directive) => ({
  name: directive.name,
  condition: directive.condition,
  action: directive.action,
  priority: directive.priority ?? null,
  description: directive.description ?? null,
}));
