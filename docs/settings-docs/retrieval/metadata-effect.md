---
title: "Metadata Rule Effect"
description: "Retrieval setting determining whether metadata rules boost matches softly or filter non-matches strictly."
last_updated: 2026-04-02
---

# Effect

## Summary
Decide whether the rule boosts matches or strictly filters non-matches.

## Details
### Overview

This setting determines whether the metadata rule behaves as a soft preference or a hard constraint.

- **Boost:** prefer matching documents
- **Filter:** remove non-matching documents

### Guidance

Use `Boost` when the rule should influence ranking without excluding other candidates. Use `Filter` when the rule is a strict requirement.
