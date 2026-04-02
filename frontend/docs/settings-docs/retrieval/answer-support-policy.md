# Unsupported Answer Policy

## Summary
Decide what happens when the assistant writes a claim that the retrieved documents do not support.

## Details
### Overview

This setting controls the final safety pass that checks whether each substantive part of the answer is backed by retrieved evidence.

### Strict Grounding

Use this when you want the shipped answer to stay tightly aligned to what the retrieved documents can support.

If the model says something unsupported, the system replaces that portion with a short non-verification notice instead of presenting the unsupported claim as fact.

### Warn Only

Use this when you want to inspect support problems without hiding the original answer text.

Unsupported text stays visible, but the validation result is still recorded for diagnostics and review.

### Off

Use this only when you explicitly do not want post-generation support correction.

The answer is returned as written, even if parts of it are not supported by the retrieved evidence.

### Tradeoff

Stricter policies improve trustworthiness but can make answers feel more conservative.

Looser policies preserve more of the model's phrasing but increase the risk that unsupported claims reach the user unchanged.
