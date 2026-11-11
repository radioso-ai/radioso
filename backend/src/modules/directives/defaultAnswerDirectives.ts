import type { Directive } from "./domain.js";

export interface BuiltInDirectiveView {
  name: string;
  // The operator-facing label. The engine `Directive` carries the stable `name` only; this is
  // display copy, so it lives on the view and never reaches the runtime.
  title: string;
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
    "When supported and the turn remains open, end with one focused question or one step the user can take themselves.",
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
    "Link a name only to an address you were given; otherwise it stays plain text. The link text must be the resource's own name as human-readable link text, not a generic pointer phrase such as 'here' or 'details'.",
    "If the user asks for a link or you direct them to open, use, register for, book, contact, download, or read a resource, include its supported inline link.",
    "Never invent a link. Never print a bare/raw URL unless the user explicitly requests the literal URL.",
    "Use the supported link; never substitute a citation marker or a parenthetical gesture.",
    "Never gather links into a trailing list, closing line, sources or read-more block, run separated by semicolons or commas, or group that follows a citation marker.",
    "Never leave a link or citation marker alone on its own line.",
  ].join(" "),
};

// The title is what operators read in the dashboard and Ray; it stays beside the engine directive
// rather than on it, and a built-in cannot be listed without one.
const builtInAnswerDirectives: ReadonlyArray<{ directive: Directive; title: string }> = [
  { directive: conciseReadableFormattingDirective, title: "Readable formatting" },
  { directive: representOrganizationDirective, title: "Speak as the organization" },
  { directive: inlineSupportedLinksDirective, title: "Inline source links" },
];

export const defaultAnswerDirectives: Directive[] = builtInAnswerDirectives.map(({ directive }) => directive);

export const builtInAnswerDirectiveViews: BuiltInDirectiveView[] = builtInAnswerDirectives.map(({ directive, title }) => ({
  name: directive.name,
  title,
  condition: directive.condition,
  action: directive.action,
  priority: directive.priority ?? null,
  description: directive.description ?? null,
}));
