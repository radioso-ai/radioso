---
title: "Docs Style Guide"
description: "How Radioso documentation should sound and how it is structured: voice, registers, banned patterns, screenshots, and frontmatter rules."
last_updated: 2026-07-27
---

# Docs Style Guide

You are writing documentation for Radioso. Read this before touching any doc; it applies to `readme.md`, everything under `docs/`, and everything under `docs-portal/content/`.

One principle above all: **write like a person explaining something to a colleague they like.** Earnest, concrete, honest about limits. If a sentence could have been generated mechanically from the feature's label, delete it and write what a human would actually say.

## Three registers, one voice

Different surfaces need different amounts of warmth, but it is always the same person talking.

| Register | Surfaces | How it sounds |
|---|---|---|
| Marketing | `readme.md` intro, `docs-portal/content/why-radioso/` | First person welcome, warm, opinionated. Light humor and self-deprecation are fine. Concrete numbers over adjectives. Honest about what doesn't work yet. |
| Guides | Quickstarts, guides, operator pages, `docs/` how-tos | Second person, contractions, friendly. Say *why* before *how*. One running example with real values per guide. A screenshot for every dashboard screen the guide walks through. |
| Reference | API pages, settings copy, normative specs | Calm, precise, plain — but still human. Full sentences that add information the heading didn't. Precision is the kindness here; jokes are not. |

Rules that hold in every register:

- Lead with what the reader gets, not with what the system is.
- Concrete over abstract: real example values, real commands, real error text. "About 2 seconds on a laptop" beats "fast".
- Name limits plainly. "The SDK does not cover browser sign-in" beats silence, and far beats spin.
- Explain in the order a reader meets the problem: what it is, why they'd want it, how to use it, what can go wrong.
- Keep the "Common failure modes" and "Read next" sections on portal pages. They earn their keep.
- Useful connective patterns: "In practice…", "The key point is…". Use them when they fit, not as tics.

## Banned

- **Label restatement.** A sentence that only repeats the heading or setting name. If the doc for a toggle called "Rule enabled" says "This is the activation switch for the rule", it has told the reader nothing.
- **Hype words.** simply, easily, seamless, powerful, robust, cutting-edge. If something is genuinely easy, show the two-line example and let it speak.
- **Time-relative claims.** "now ships", "new", "recently added". Docs outlive the moment they were written.
- **Futures and migrations.** "reserved for a future router", "planned for a later release", "not available yet", "legacy", "deprecated", "during cutover". Describe what exists right now, in present tense. A plain limit statement is fine ("The SDK does not cover browser sign-in"); a promise or hint that it will change is not. Roadmap talk lives in issues and specs, not user docs.
- **Copy-paste boilerplate.** The same hedge sentence pasted into three files is a machine-tell. If two route families exist, document both as present facts with the actual endpoints.
- **Competitor comparisons.** Describe Radioso on its own terms. No put-downs of other tools, however witty.
- **Filler openers.** Don't warm up. Start with the thing.

Humor: at most a light aside, and never in security, error, or reference content. Emoji: marketing register only, and sparingly.

## Vocabulary

- **Agent** is the configured persona a workspace runs — use it in prose.
- **Assistant** survives in API paths and module names (`/api/v1/assistant/chat`). Use "assistant" only when naming those literal surfaces, and say once per page that the assistant chat API is how you talk to an agent.
- Skills act, directives steer, routines carry a flow across turns. Keep these three verbs stable everywhere.

## Before and after

Real examples from this repo. The "before" text shipped.

**Label restatement** (settings copy):

> Before: "This is the activation switch for the rule."
>
> After: "Turn the rule off to take it out of play without losing its configuration. Useful when you want to compare retrieval with and without the rule, or park one while debugging."

**Bullet-dump with no connective prose** (settings copy):

> Before: "Lower Values — terse / direct / efficient. Higher Values — softer / more conversational / more guided."
>
> After: "At low values the agent answers in a sentence or two and moves on. At high values it explains its reasoning and offers next steps. Neither changes what evidence the answer is built on — only how it is delivered."

**Time-relative claim**:

> Before: "Radioso now ships a repo-owned benchmark harness under `scripts/performance/`."
>
> After: "The benchmark harness lives under `scripts/performance/`."

**Boilerplate hedge**:

> Before: "Legacy webhook skill endpoints may remain available during cutover."
>
> After (verified against the code first): "The per-type webhook routes below also work and operate on the same `agent_skills` records. The unified `/skills` endpoints are the primary surface."

## Screenshots

Guides that walk through the dashboard show it.

- Images live in `docs-portal/public/screenshots/`, named `<section>-<page>-<subject>.png` (for example `quickstarts-run-locally-first-answer.png`).
- Capture with the checked-in script `docs-portal/scripts/capture-screenshots.mjs` against a local stack (`./run-dev.sh`) with the seeded demo workspace, so screens show believable data rather than empty states. Consistent viewport; light theme.
- Alt text says what the reader should notice ("The Sources list with three documents in Processed state"), not "screenshot of the app".
- When a screen changes meaningfully, retake its screenshot in the same change. A stale screenshot is worse than none.

## Frontmatter

Every Markdown file under `docs/` (including settings docs) starts with a YAML frontmatter block. It carries page metadata and is never shown in the body.

Use exactly these keys:

```yaml
---
title: "Human-readable page title"
description: "One sentence describing what the page covers."
last_updated: 2026-06-18
---
```

Rules:

- Quote `title` and `description` with double quotes. Quoting is required when a value contains a colon, such as `"Radioso TypeScript SDK: Basic Usage"`.
- Keep `description` to a single sentence. It feeds the docs portal meta description and search, so describe the content, not the document type.
- Write `last_updated` as an ISO date (`YYYY-MM-DD`) reflecting the last meaningful content change, not the day you touched formatting.
- Make `title` specific enough to stand alone in a flat list. Prefer `"Metadata Rule Operator"` over `"Operator"`.

How it is used:

- In the docs portal (Nextra), frontmatter is read for the page title, meta description, and sidebar entry. It is not rendered in the page body.
- In the settings UI, the parser reads only the `#` heading and the `## Summary` and `## Details` sections. Frontmatter is ignored, so it never appears to the reader.

Keep the heading and the frontmatter `title` consistent in meaning, but they do not have to be identical. The settings UI shows the `#` heading; the portal shows the `title`.

Settings docs exist in two copies: the source under `docs/settings-docs/` and the copy the dashboard imports under `frontend/docs/settings-docs/`. When you edit a settings doc, change both copies so their frontmatter and body stay in sync.

## Litmus tests

Before you commit a doc, check:

1. Read a paragraph aloud. Would you say it to a customer over coffee? If you'd be embarrassed, rewrite it.
2. Does every sentence add something the heading didn't already say?
3. Could a reader paste the example and have it work? (Verify claims against the code — endpoints, field names, defaults. Docs that lie are worse than docs that are missing.)
4. Did you touch a screen the docs show? Retake the screenshot.

Final rule, unchanged from the first version of this guide because it was right: explain what is true, as simply as possible, without trying to make it sound important.
