# Unsupported Answer Policy

## Summary
Decide what happens when the assistant writes a claim that the retrieved documents do not support.

## Details
### Overview

This setting controls the final safety pass that checks whether each substantive part of the answer is backed by retrieved evidence.

### Strict Grounding

Use this when you want the shipped answer to stay tightly aligned to what the retrieved documents can support.

If the model says something unsupported, the system does not present that claim as grounded fact.

When the answer includes both supported and unsupported parts, unsupported parts are replaced with a short non-verification notice.

When the exact requested answer is unsupported but the assistant did retrieve nearby relevant material, the final response may stay conversational and point the user toward that adjacent grounded material instead of ending with a dead-end refusal.

When nothing relevant was retrieved, the assistant stays explicit that it did not find supporting material in the workspace documents and does not switch into a generic answer mode.

### Warn Only

Use this when you want to inspect support problems without hiding the original answer text.

Unsupported text stays visible, but the validation result is still recorded for diagnostics and review.

### Off

Use this only when you explicitly do not want post-generation support correction.

The answer is returned as written, even if parts of it are not supported by the retrieved evidence.

### Tradeoff

Stricter policies improve trustworthiness but can make answers feel more conservative.

Looser policies preserve more of the model's phrasing but increase the risk that unsupported claims reach the user unchanged.
