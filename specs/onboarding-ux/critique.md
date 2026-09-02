# Adversarial UX critique — onboarding mockup (2026-09-01)

> **Patch status (same day):** findings **1, 2, 3** (blockers: no-key rail via "Simulate: fresh self-host" toggle, async processing strip on Test, handoff test-send + confirmed receipt + mail-driver warning), **5** (outcome-based done flags), **6** (rail locks forward jumps), **7** ("I've stored it" gates Finish), **8** (least-privilege default + plain-language roles), **9** (done checklist items route to owning surfaces), **10** (state-aware Ray), **13** (neutral attribution), **14** (kind definitions), **15** (polling inbox tab), **18** (Continue always enabled), and partials of **11** (keyboard on cards, switch semantics, aria-live toast, darker small-text blue), **19** (zero-checked Apply disabled), **21** (origins line), **22** (badge semantics, address leak, "free" dropped) are patched into `mockup.html`. Deferred to the spec/build: **4** (non-crawl paths for steps 4–6), **12** (mobile), **16/17** (positioning + persona screens), full **11**, ToS consent.
>
> **Owner-driven remodel (same day):** the Handoff step was rebuilt after owner feedback — handoff is an action a routine performs (Notify Human skill), not a workspace toggle. The step now shows an always-on Inbox card + a notify destination (test-send/confirm retained), names the starter routine that ends in handoff (degrading when the pack was skipped), and the visitor demo is asynchronous with contact capture — nobody waits in the widget.

Produced by an adversarial review agent against `mockup.html`, grounded in `.context/onboarding-ux-audit.md`, the full interaction source, all desktop screenshots, and fresh 375×812 / 1280×800 captures. Ranked by damage. Severity: blocker / major / minor / nit.

## Blockers

1. **The flow's spine assumes a configured LLM; the unconfigured self-hoster hits four broken steps in a row.** Website analysis, Behavior generation, the Test chat, and every Ray suggestion all require a model call, but `./run-dev.sh` permits skipping the provider key by design. The "degrades to add rules later" claim is an annotation, not a designed screen, and nothing addresses steps 2 and 4. Fix: design the no-key rail as a first-class variant (key-setup interstitial or visibly-degraded steps).

2. **The Test step pretends ingestion is synchronous.** Crawl ends with "processing has started," yet Test claims "Grounded in the 12 pages just imported" one click later. A real 200-page crawl means ungrounded/empty answers as the user's first impression of the core promise. Fix: readiness state on Test — pages-processed progress, suggested questions only from processed pages, or an honest gate.

3. **Handoff demos a notification the product can't currently deliver.** Self-host default is `MAIL_DRIVER=log`, SMTP is undocumented, notify delivery has a known broken half — yet the visitor card says "support@… was notified." First real escalation lands in backend logs while a customer waits; trust destroyed on the differentiator. Fix: send a real test notification in-step and require confirmed receipt (or surface mail-driver status) before the success card.

## Major

4. **Everything after Knowledge is specced only for the website-crawl happy path.** Upload/sample/skip paths have no designed step 4/5/6 (name? greeting? suggested questions? slug?), and the most common real crawl outcome — blocked by Cloudflare — has no failure state.
5. **Checklist "done" means "wizard screen clicked."** Skipping Deploy marks it done; Test is done after one canned question. Bind per-item done-criteria to server-derived outcomes (doc counts, first conversation, credential existence), not navigation events.
6. **The rail permits free forward jumps with zero dependency handling.** Jump to Behavior with empty purpose → generation with no seed; jump to Test with no knowledge → chat against nothing; Deploy reachable and finishable from a virgin flow.
7. **Shown-once secret sits directly above the primary exit CTA with no acknowledgment gate.** Wizard-completion momentum → secret gone → first API call 401s. Require "I've stored it" (plus download) before step completion.
8. **The credential role choice is undecidable for a first-ten-minutes user.** No explanation of member vs admin or personal vs service; predictable move is "admin, to be safe" — onboarding nudges over-privilege on day one of the least-privilege model. Default least-privilege, plain-language one-liners, advanced behind disclosure. (Select also truncates at 1280px.)
9. **Checklist deep-links resurrect the full-screen wizard forever — a permanent second UI for six settings areas.** Post-completion, items must link to owning product surfaces (Channels, Behavior tab, API access); wizard steps are pre-completion only. This repo has already been burned by two-producers drift.
10. **Ray's dashboard copy is state-blind in both directions.** At 0/6: "Your agent is up and answering." At 6/6 with handoff done: first suggestion is still "add a human handoff path," contradicting the checklist beside it. Derive greeting/suggestions from the same server-side setup state.
11. **Accessibility broken at cannot-complete-the-flow level.** Knowledge cards are divs with only `onclick` (Enter/Space dead — keyboard user cannot pick a source); handoff switch is a nameless button with no `role="switch"`/`aria-checked` gating Continue; checkboxes unlabelled; step changes move no focus and announce nothing; toasts have no `aria-live`; brand blue #5096e7 on white ≈3.1:1, failing AA on 11px labels and small links.
12. **Mobile is anti-designed.** Zero media queries; at 375px the 300px rail leaves the Purpose step one word per line; Ray panel + review pill cover the dashboard. Scene 0 explicitly courts phone signups.
13. **"Drafted by Ray" attributes work to a character the user has never met.** Introduce Ray in one sentence at step 3, or attribute neutrally ("Drafted from your purpose") and let Ray introduce itself on the dashboard.
14. **Directive/Routine jargon lands unexplained at first contact.** One plain-language line per kind, on the card, at first appearance.
15. **Verify step ignores that the email link opens in another tab/device.** The waiting tab has no path to the verified state — the audit's hardest funnel break reproduced one screen later. Waiting tab should poll and advance; design both-tab outcomes.
16. **Landing headline and primary CTA sell opposite things.** "One self-hosted platform" + "Start in the cloud — free" reads as bait-and-switch to the privacy visitor; "free" is an unpriced business commitment. Headline must span both deployment modes. (Owner-level messaging decision.)
17. **Ignored personas remain ignored.** No closed-registration screen for the OSS second visitor; invitees get zero orientation; API-first developer has no "skip to API" path; "first launch of *what*" (the veteran's Nth empty workspace) is unspecified.
18. **Handoff Continue is gated on toggling ON — "no" is a second-class answer.** Continue always enabled; toggle state is the answer. Notify field editable while toggle off implies it's wired.
19. **Proposal cards can be unchecked but not edited; Apply with zero checked is enabled and undefined.** Also undesigned: purpose language vs site language conflict (the mockup stages Italian purpose + English site and never resolves it).

## Minor / Nit

20. **Load-bearing outcomes delivered only via 2.6s toasts** — apply results, credential creation, and the only pointer to where the dismissed checklist reopens (an undesigned Settings surface).
21. **Deploy shows the cloud persona a self-host placeholder** (`your-radioso.example`); embed card claims origin-locking with no origin control in the step; "Organization defaults to email domain" yields org "Gmail" for consumer addresses.
22. **Yellow badge means two unrelated things** ("Recommended" and "2 min"); visitor-side handoff card leaks the internal notify address; no ToS/privacy consent on a cloud account-creation form (legal will upgrade that to blocker later).

## Mockup artifacts (prototype shortcuts hiding real spec debts)

- Empty purpose silently injects the roastery example → masks the undesigned empty/invalid-purpose state.
- Demo-data incoherence (org "Ausalt" vs workspace "Aurora Roasters") → hides the absent workspace-naming moment.
- Canned latencies and a hardcoded fluent-Italian answer with an English citation → compress away the latency/quality variance whose handling is the actual design work.
- Load-bearing claims ("saved server-side," "degrades gracefully," "reopen from Settings") live only in Design-notes overlays or toasts, with no designed state behind them.
- Inert inputs (Test free-text, Ray input), landing "Log in" routing to signup, stale progress-ring frame — harmless, don't cargo-cult.
