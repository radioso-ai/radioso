---
title: "Answering Strategy"
description: "Choice between fixed-pipeline standard, agent-driven reasoning, or automatic strategy selection for grounded answers."
last_updated: 2026-07-27
---

# Answering Strategy

## Summary
Choose how this agent produces grounded answers: a fixed pipeline, a reasoning agent, or automatic selection.

## Details
### Overview

The answering strategy decides *how* retrieval runs for each question. The result is the same kind of grounded answer; the difference is the path taken to produce it.

### The options

- **Standard** runs a fixed pipeline: interpret the question, search, rank, and answer in a set order. It is fast and predictable.
- **Reasoning (experimental)** runs an agent that decides its own steps. It can search more than once and refine the query before answering. It is slower and costs more, but handles harder, multi-part questions better.
- **Automatic** behaves exactly like Standard.

### How it works

The setting is a preference, not a hard switch inside a single run. For each turn, the retrieval controller reads the preference and runs the matching strategy. Standard and Reasoning share the same question interpretation and the same answer format; only the retrieval steps differ.

### Practical implication

Leave this on **Standard** for most agents. Choose **Reasoning** when the agent's content needs multi-step lookups and you accept higher latency and cost. The choice applies to this agent's `retrieval.answer` skill. Retrieval-only API, SDK, and MCP calls without an agent use system defaults.
