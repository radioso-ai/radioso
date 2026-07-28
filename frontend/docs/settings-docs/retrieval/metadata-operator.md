---
title: "Metadata Rule Operator"
description: "Explanation of comparison operators (equality, containment, threshold) for filtering chunks by metadata field."
last_updated: 2026-07-27
---

# Operator

## Summary
How the rule compares the metadata field to your value — exact match, contains, or above/below a threshold.

## Details
The operator is the test applied between the field and the value: must they be exactly equal, is it enough for the field to contain the value, or should the field fall above or below a numeric or date threshold? Which operators are offered depends on the value type you chose.

Pick the operator to match how clean the metadata really is. `equals` fits standardized fields like a two-letter language code, where every document uses the same form. A `contains` test is safer for free-text fields where the same idea is written several ways. For dates and numbers, the threshold operators — `gt`, `lte`, and their siblings — express ranges like "published on or after this date."
