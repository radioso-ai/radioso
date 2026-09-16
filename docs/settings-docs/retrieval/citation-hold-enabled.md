---
title: "Citation Hold"
description: "Retrieval setting controlling whether a grounded answer is held until it earns its first citation before it streams."
last_updated: 2026-09-16
---

# Citation Hold

## Summary
Hold the answer until it cites a source. Answers stream immediately when off; an answer with no citations is still shown and flagged in Quality.

## Details
### Overview

Once the agent commits to answering from the Results, the citation hold withholds that answer's text until it has produced one complete, in-range citation. A decline — the agent saying it does not have this in the workspace, or that the request is out of scope — is never held: it streams as soon as the agent writes it, on or off.

### Default

The citation hold is on by default. An answer commitment streams only after it earns a citation, so a visitor never sees prose that turns out to be uncited.

### What Changes When It's Off

- The first token releases as soon as the agent has committed to answering, instead of waiting for a citation.
- An answer that finishes with zero sourced claims is delivered exactly as written. It is not rewritten into a decline.
- That answer's turn is recorded as degraded in Quality, so it stays visible there rather than being silently swapped out.

### Why It Exists

The hold trades latency for a floor on what a visitor sees: holding text until a citation appears means an answer that never earns one gets rewritten into a decline before it reaches the visitor, at the cost of the time spent waiting. On a corpus where citations reliably land, that wait rarely pays for itself — the answer would have cited anyway, and the hold just adds time to every turn.

### Usage Guidance

Turn it off when first-token latency matters more than catching every uncited answer before it ships, and when Quality review is part of how the workspace is operated — a degraded answer is a signal to check, not a silent failure. Keep it on when an uncited answer reaching a visitor is worse than the extra second or two it takes to write one that cites.

This setting is per agent through the agent's retrieve skill settings, so an agent whose material rarely carries clean citations can turn its own hold off without changing the workspace default other agents use.
