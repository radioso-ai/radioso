# Custom Instruction

## Summary
Add assistant-owned answer guidance for customer-facing chat responses.

## Details
### Overview

This is the workspace-level assistant instruction for what the assistant helps with and how customer-facing answers should be written.

In practice, it applies to assistant chat responses after the assistant decides whether the current message can be answered directly or needs retrieval. It is not a retrieval tuning field.

### Appropriate Uses

- formatting rules
- answer style
- citation style
- assistant purpose and scope
- domain-specific response habits

### Inappropriate Uses

Do not use this as a bandage for retrieval problems.

If the wrong evidence is being found, the fix belongs in ingestion or retrieval settings, not here. Use retrieval rewrite, ranking, and metadata controls for evidence quality.
