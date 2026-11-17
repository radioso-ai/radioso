---
title: "Chunk Size"
description: "Tuning guide for fixed-window chunk sizes balancing context coverage against retrieval precision."
last_updated: 2026-11-17
---

# Chunk Size

## Summary
Set how much text goes into each chunk for the fixed-window and recursive-text chunking strategies.

## Details
With fixed-window or recursive-text chunking, no chunk holds more than this many characters, and the number trades context against precision. A fixed-window chunk ends at a sentence end in the second half of that space when there is one, so most chunks fill between half and all of it. Larger chunks keep more surrounding explanation together, which helps when the sentence that answers a question only makes sense alongside its neighbors — but they also make retrieval blunter and citations bulkier, since a returned chunk carries more text that is not strictly relevant. Smaller chunks pinpoint evidence more sharply and cite tightly, at the risk of clipping a thought partway and leaving the explanation around it behind.

Tune by the failure you actually see. If citations feel bloated and the right chunk arrives buried in unrelated text, make chunks smaller. If answers feel clipped and adjacent chunks obviously belonged together, make them larger. This applies to the fixed-window and recursive-text strategies; semantic chunking sizes chunks by its own minimum and maximum instead. Chunk overlap, next door, stays fixed-window only.
