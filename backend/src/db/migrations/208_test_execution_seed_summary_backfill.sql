-- Fills migration 207's seed summary for tests seeded before it existed, so Conversation history and
-- Ray's test_chat_sessions keep counting what those tests copied in. A seeded test's copied messages
-- are the user entries in its side history that no sent turn owns: every message the operator sends
-- has a row in agent_test_execution_turns, and a side retained from a comparison copies its turns
-- along. Only a single-revision test can be seeded, so only those are read, and side 0 holds the whole
-- thread. The first copied message with any non-whitespace character labels the test, kept to 1,000
-- characters, as the app's seed summary does (its whitespace test is
-- JavaScript's, which can differ from Postgres's on rare Unicode spaces).
--
-- A test seeded by a still-running older instance after this runs keeps the defaults: its list count
-- leaves out the copied messages. Its transcript is unaffected.
--
-- Only rows still at the default are touched, so a re-run changes nothing.
--
-- Locks. A separate migration from 207, so 207's ACCESS EXCLUSIVE on agent_test_executions has
-- already committed. This UPDATE takes ROW EXCLUSIVE and locks only the rows it changes: reads of
-- test executions never wait, and a write to one being backfilled waits for this transaction. It
-- expands only the side-0 histories of single-revision tests still at the default, once each;
-- retention bounds how many there are.
UPDATE agent_test_executions AS execution
SET seeded_turn_count = copied.turn_count,
    seeded_first_message = copied.first_message
FROM (
  SELECT
    side.execution_id,
    count(*) AS turn_count,
    -- Stops at the first copied message with text, so only that one is cut.
    (
      SELECT left(first_item.entry ->> 'content', 1000)
      FROM jsonb_array_elements(side.history) WITH ORDINALITY AS first_item(entry, ordinal)
      WHERE first_item.entry ->> 'role' = 'user'
        AND first_item.entry ->> 'content' ~ '\S'
        AND NOT EXISTS (
          SELECT 1
          FROM agent_test_execution_turns AS turn
          WHERE turn.execution_id = side.execution_id
            AND turn.turn_id::text = first_item.entry ->> 'turnId'
        )
      ORDER BY first_item.ordinal
      LIMIT 1
    ) AS first_message
  FROM agent_test_execution_sides AS side
  JOIN agent_test_executions AS candidate
    ON candidate.id = side.execution_id
   AND candidate.mode = 'single'
   AND candidate.seeded_turn_count = 0
   AND candidate.seeded_first_message IS NULL
  CROSS JOIN LATERAL jsonb_array_elements(side.history) AS item(entry)
  WHERE side.side_ordinal = 0
    AND item.entry ->> 'role' = 'user'
    AND NOT EXISTS (
      SELECT 1
      FROM agent_test_execution_turns AS turn
      WHERE turn.execution_id = side.execution_id
        AND turn.turn_id::text = item.entry ->> 'turnId'
    )
  -- Grouped by the side's key, never its history: hashing whole histories would detoast every trace.
  GROUP BY side.id
) AS copied
WHERE execution.id = copied.execution_id
  AND execution.mode = 'single'
  AND execution.seeded_turn_count = 0
  AND execution.seeded_first_message IS NULL;
