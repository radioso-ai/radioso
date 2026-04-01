# Vector Top K

## Summary
Set how many semantic candidates to pull from vector search.

## Details
### Overview

`Vector Top K` controls how many semantic candidates are retained after vector search.

### Higher Values

A bigger number means:

- wider recall
- more chances to include a relevant chunk
- more noise entering later stages

This is useful when the best evidence is not always ranked near the top.

### Lower Values

A smaller number means:

- tighter pool
- faster downstream work
- less noise
- more risk of missing good evidence

### What It Does Not Do

This setting does **not** directly improve ranking quality.

It improves the *chance* that good material is still present in the pool so later stages can do something useful with it.

### Tuning Signals

- If obvious evidence is missing, raise it.
- If the system keeps dragging in weakly related chunks, lower it.
