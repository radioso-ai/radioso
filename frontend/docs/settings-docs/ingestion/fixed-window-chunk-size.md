---
title: "Chunk Size"
description: "Tuning guide for fixed-window chunk sizes balancing context coverage against retrieval precision."
last_updated: 2026-07-27
---

# Chunk Size

## Summary
Set how much text goes into each chunk when fixed-window chunking is active.

## Details
With fixed-window chunking, every chunk holds roughly this much text, and the number trades context against precision. Larger chunks keep more surrounding explanation together, which helps when the sentence that answers a question only makes sense alongside its neighbors — but they also make retrieval blunter and citations bulkier, since a returned chunk carries more text that is not strictly relevant. Smaller chunks pinpoint evidence more sharply and cite tightly, at the risk of clipping a thought partway and leaving the explanation around it behind.

Tune by the failure you actually see. If citations feel bloated and the right chunk arrives buried in unrelated text, make chunks smaller. If answers feel clipped and adjacent chunks obviously belonged together, make them larger. This applies only to fixed-window chunking; semantic chunking sizes chunks by its own minimum and maximum instead.
