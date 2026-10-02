-- Fills migration 207's seed summary for tests seeded before it existed, so Conversation history and
-- Ray's test_chat_sessions keep counting what those tests copied in. A seeded test's copied messages
-- are the user entries in its side history that no sent turn owns: every message the operator sends
-- has a row in agent_test_execution_turns, and a side retained from a comparison copies its turns
-- along. Only a single-revision test can be seeded, so only those are read, and side 0 holds the whole
-- thread. The first copied message with any non-whitespace character labels the test, kept to 201
-- characters, one more than a label shows; the app's seed summary applies the same two rules.
--
-- Only rows still at the default are touched, so a re-run changes nothing.
--
-- Locks. A separate migration from 207, so 207's ACCESS EXCLUSIVE on agent_test_executions has
-- already committed. This UPDATE takes ROW EXCLUSIVE and locks only the rows it changes: reads of
-- test executions never wait, and a write to one being backfilled waits for this transaction. It reads
-- each side-0 history once; retention bounds how many there are.
UPDATE agent_test_executions AS execution
SET seeded_turn_count = copied.turn_count,
    seeded_first_message = copied.first_message
FROM (
  SELECT
    side.execution_id,
    count(*) AS turn_count,
    (array_agg(left(item.entry ->> 'content', 201) ORDER BY item.ordinal)
      FILTER (WHERE item.entry ->> 'content' ~ '\S'))[1] AS first_message
  FROM agent_test_execution_sides AS side
  CROSS JOIN LATERAL jsonb_array_elements(side.history) WITH ORDINALITY AS item(entry, ordinal)
  WHERE side.side_ordinal = 0
    AND item.entry ->> 'role' = 'user'
    AND NOT EXISTS (
      SELECT 1
      FROM agent_test_execution_turns AS turn
      WHERE turn.execution_id = side.execution_id
        AND turn.turn_id::text = item.entry ->> 'turnId'
    )
  GROUP BY side.execution_id
) AS copied
WHERE execution.id = copied.execution_id
  AND execution.mode = 'single'
  AND execution.seeded_turn_count = 0
  AND execution.seeded_first_message IS NULL;
