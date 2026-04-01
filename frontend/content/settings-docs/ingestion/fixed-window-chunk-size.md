# Chunk Size

## Summary
Set how much text each fixed-window chunk should contain.

## Details
### Overview

Chunk size controls how much text is placed into each chunk when fixed-window chunking is active.

### Larger Values

Bigger chunks mean:

- more surrounding context stays together
- answers may have more local context available
- retrieval becomes less precise

This helps when the important sentence depends on nearby explanation.

### Smaller Values

Smaller chunks mean:

- more precise retrieval
- easier pinpointing of exact evidence
- more risk of fragmented context

This helps when you want retrieval to be surgical rather than broad.

### Core Tradeoff

Bigger chunks improve context.
Smaller chunks improve precision.

### Symptoms Of Oversized Chunks

- citations feel bloated
- the right chunk is returned, but it contains lots of irrelevant text
- answers quote or rely on evidence that feels broader than necessary

### Symptoms Of Undersized Chunks

- answers feel clipped
- the system retrieves one part of an idea but misses the explanation around it
- adjacent chunks look like they should have stayed together

### Tuning Guidance

Tune based on the failure mode you observe:

- too broad -> decrease
- too fragmented -> increase
