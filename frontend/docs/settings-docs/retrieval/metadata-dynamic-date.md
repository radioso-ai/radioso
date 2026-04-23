# Dynamic Date Values

## Summary
Use `today()` in supported date comparisons so time-based rules stay current without manual edits.

## Details
### Overview

`today()` is a dynamic token for date-valued metadata rules.

Radioso resolves it when retrieval runs, using the current UTC day boundary.

### Supported Use

Use `today()` only with date rules and comparison operators such as:

- `equals`
- `not_equals`
- `lt`
- `lte`
- `gt`
- `gte`

### Practical Implication

This is useful for rules like "dateFrom is greater than or equal to today()" when you want upcoming material to stay fresh automatically.

The key point is that `today()` is evaluated at retrieval time, not when you save the setting.
