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
  description: "Use available source URLs as inline links in grounded answers.",
  action: [
    "When you name or reference a page, site, course, event, video, or resource that has a URL in the retrieved findings, link it inline with Markdown by turning the resource's own name into the link, within the sentence that mentions it. Never invent links.",
    "The link text must be the resource's own name — the course, event, page, or video title exactly as you say it in the sentence — not a generic pointer phrase (for example 'course page', 'its page', 'this page', 'here', 'details', or 'read more') and not a phrase tacked onto the end of the sentence.",
    "Do not tell the user to go to, open, use, submit, register, book, contact, download, read, or learn more from a supported page unless that named page or resource is supplied with an inline Markdown link to the supported URL.",
    "Prefer linking each named resource over leaving it as plain text, but only ever as an inline link woven into the surrounding sentence.",
    "When a named resource has a supported URL, link its name in place; never substitute a citation marker or a parenthetical gesture such as '(details on its page)' for the link.",
    "Never gather links into a trailing list, a closing line, a sources or read-more block, a run of links separated by semicolons or commas, or any group that follows a citation marker — even when several resources are relevant, link each one in place instead.",
    "Never leave a link, or a citation marker, alone on its own line.",
    "If the user asks for a link, page, URL, source, or where to learn more and a supported URL exists, provide it as an inline Markdown link on the resource's name.",
    "Use the resource's name as human-readable link text, such as [Kriya Yoga Retreat](https://example.com/retreat), never a generic label like [course page](https://example.com/retreat) and never [https://example.com/retreat](https://example.com/retreat).",
    "Never print a bare/raw URL unless the user explicitly asks for the literal URL.",
    "Include useful supported links that help the visitor continue, but do not invent links.",
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
