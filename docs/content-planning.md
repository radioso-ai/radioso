---
title: "Continuous Content Planning"
description: "How Radioso turns recent visitor questions and grounding evidence into a near-current, privacy-aware content plan."
last_updated: 2026-08-02
---

# Continuous Content Planning

Content plan tells an operator what visitors have been asking about, where answers
have reduced or no grounding support, and which content action has the strongest
evidence behind it. Open **Activity → Content plan** to see the rolling last 30 days
against the preceding 30 days.

There is no report-generation button or weekly job. Each eligible committed turn adds
small, asynchronous work to a durable projection. In practice, the page stays close to
current without putting clustering or provider calls on the visitor-facing answer path.

## What becomes an observation

The conversation runtime gives each committed turn a structured interaction role.
Substantive questions, contextual follow-ups, and resolved clarification values can
contribute an information need. Social replies, control messages, and routine values do
not become topics on their own.

Short replies such as “yes,” “the second one,” or “go ahead” are handled with their
conversation context. If a reply resolves a previous clarification, the original
question supplies the semantic meaning. If the system cannot resolve the reply safely,
it waits for bounded context and then excludes it rather than embedding the fragment as
a new topic.

Raw visitor wording remains on the source message. The projection stores source
identifiers, a non-reversible semantic hash, grounding evidence, and reusable vector
envelopes. Deleting the message removes its text, vectors, and memberships and causes
affected topic evidence to be reconciled.

## How questions become topics

Retrieval already embeds semantic search intents. Content Planning reuses every
compatible vector, so the normal path adds no second embedding request. A bounded
worker requests a fallback embedding only when the turn has no compatible reusable
vector.

The worker compares a ready observation with existing topic centroids in the same
embedding space. A strong match joins that topic only when the updated cluster remains
cohesive. Otherwise, the observation starts or joins provisional evidence. A topic
becomes mature after at least two coherent observations from at least two conversations.
Single questions remain visible under **Emerging questions** instead of disappearing.

Nearby topics can merge when both centroid similarity and combined cohesion pass the
versioned policy. Existing shared links resolve to the surviving topic while the
redirect remains valid. An embedding-space change builds a separate generation and
publishes it only after the new projection is coherent, so reads never mix vector
spaces.

## Reading the report

The four summary values answer different questions:

- **Visitor questions** counts distinct contributing messages in the current window.
- **Topics** counts mature semantic clusters; provisional evidence is shown separately.
- **Opportunities** counts mature topics with active reduced/no-support evidence from
  at least two distinct conversations.
- **Grounding gaps** measures reduced or no support only among evaluated answers.

The grounding composition has three measured verdicts: grounded, reduced support, and
no support. Answers without a grounding verdict are shown separately as **not
evaluated**. When fewer than five evaluated conversations support a topic, the UI leads
with raw counts instead of presenting a percentage as strong evidence.

**Recommended next** is singular and comes from the same server ordering as the topic
list. Open a topic to inspect the decision, freshness, representative questions,
related documents, affected agents, and channels. From there you can review the member
answers in Quality, inspect related knowledge, or begin an inline document with a
suggested title and question-only outline.

## How an action is chosen

An action is deterministic evidence, not a model opinion:

- **Add content** means a successful corpus check found no sufficiently related
  document.
- **Investigate retrieval** means relevant knowledge existed before the gap answers,
  but those answers generally did not retrieve or cite it.
- **Review existing content** means related knowledge was retrieved but insufficient,
  or it was added or changed after the observed gap and should be checked and retested.
- **Monitor** means there is interest but not enough active evidence for remediation.

Corpus similarity shows possible relevance, not document completeness. If corpus
evidence is unavailable, the action remains unavailable rather than guessing “Add
content.” Generated labels and briefs help the operator navigate the evidence; they do
not affect ranking or action selection. A generated brief contains questions to answer,
not factual answers, and always requires fact verification before publication.

## Freshness and partial states

The header shows the report's `as of` time and the worker's processed-through time. A
quiet status strip distinguishes pending embeddings, pending assignments, and pending
enrichments. Bootstrap, delayed, budget-paused, degraded, and embedding-reprojection
states keep the last coherent evidence visible where one exists.

A label or brief can be pending, stale, unavailable, or outside the current analysis
cap without hiding demand and grounding counts. Provider failure is therefore a
partial-enrichment state, not a failed report.

## Limits

The first report uses fixed current and comparison windows of 30 days. Operators cannot
rename, split, pin, or manually merge topics. Content Planning does not publish or edit
documents, resolve Quality items in bulk, tune retrieval by topic, export a calendar, or
feed report topics back into visitor answers.
