# Trigger Instruction

## Summary
Describe the kind of question that should activate a trigger-based metadata rule.

## Details
### Overview

This instruction tells the model what a matching turn looks like.

Keep it concrete and operator-facing. The instruction should describe the user's question pattern, not a retrieval implementation detail.

### Good Examples

- Enact when the user is clearly asking about upcoming events or conferences.
- Enact when the user wants active courses, camps, or currently open registrations.
- Enact when the user asks for policies that apply today rather than archived versions.

### Practical Implication

If the instruction is vague, the rule may activate too often or not often enough.

Short, specific instructions are easier to debug because the same text appears in retrieval diagnostics.
