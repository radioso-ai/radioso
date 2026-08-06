-- Records which named skill fired an outbox action, so the drain-time delivery
-- resolver can honor that skill's own configuration instead of falling back to a
-- hardcoded skill name. Generic across the outbox, not contact-specific: any
-- skill-emitted action (notify, handoff, approval, webhook) can carry its firing
-- skill's identity. Nullable — a routine action step that emits an action
-- directly (not through a named skill invocation) has no skill identity, and
-- rows enqueued before this column existed keep draining unchanged with a null
-- skill_name.

ALTER TABLE routine_action_requests
  ADD COLUMN IF NOT EXISTS skill_name TEXT;
