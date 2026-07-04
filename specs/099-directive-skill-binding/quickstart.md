# Quickstart: Directive Skill Binding

Exercise the feature end-to-end against a local stack (`./run-dev.sh`):

1. Ensure the agent has a turn-selectable skill enabled (e.g. an external skill with
   `invocation_mode = agent_selectable`), plus workspace token auth.
2. Create a bound directive:

   ```bash
   curl -X POST "$API/api/v1/agents/$AGENT_ID/directives" \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{
       "name": "order-status-binding",
       "condition": {"kind": "contextual", "description": "the user asks about the status of an order"},
       "action": "Look the order up before answering; never guess order state.",
       "binding": {"kind": "skill", "skillName": "<skill-name>"}
     }'
   ```

3. Send a matching message via test chat; inspect the turn's conversation trace:
   selection decision reason should be `directive:order-status-binding` and the bound
   skill should have handled the turn.
4. Send a non-matching message: default selection, unchanged behavior.
5. Disable the bound skill; send a matching message: normal reply, trace records the
   skipped binding with reason, backend log shows the warn event (no message content).
6. Validation check: POST a directive with `"skillName": "nope"` → 400 naming the skill.
7. Round-trip: export the agent config, import into a fresh agent with the same skill
   enabled, repeat step 3 with identical results.
