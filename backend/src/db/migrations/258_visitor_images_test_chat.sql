-- Photos an operator attaches in the dashboard's Test Chat. A test keeps its transcript in its own
-- tables, never in conversations and messages, so a photo a test turn carries is bound to the test
-- instead (`test_execution_id`) and is kept with it, while one no message and no test carries is
-- still deleted a day after its upload.
--
-- The foreign key sets the column to NULL when the test is deleted (Test Chat's retention), which
-- leaves the photo carried by nothing, so the unbound sweep deletes it and hands its object to the
-- deletion job, as it does for a message deleted on its own. A cascade would strand the object.
-- A photo is carried by a conversation's message or by a test, never both.
--
-- The unbound index is rebuilt to leave out the photos a test carries, which the sweep skips.
--
-- Locks. The column is added without a default, a catalog change, and its foreign key takes SHARE
-- ROW EXCLUSIVE on agent_test_executions for the instant it is created. The CHECK is added NOT
-- VALID and validated after; visitor_images holds no row that a test carries, and the table is
-- small. The wait for each lock is bounded to three seconds; a migration that cannot get one rolls
-- back whole and is safe to run again.
SET LOCAL lock_timeout = '3s';

ALTER TABLE visitor_images
  ADD COLUMN test_execution_id UUID REFERENCES agent_test_executions(id) ON DELETE SET NULL,
  ADD CONSTRAINT visitor_images_one_holder
    CHECK (test_execution_id IS NULL OR conversation_id IS NULL) NOT VALID;

ALTER TABLE visitor_images VALIDATE CONSTRAINT visitor_images_one_holder;

-- A test's photos: its transcript's thumbnails and the SET NULL.
CREATE INDEX visitor_images_test_execution_idx ON visitor_images (test_execution_id) WHERE test_execution_id IS NOT NULL;

-- The unbound sweep: photos no message and no test carries, oldest first.
DROP INDEX visitor_images_unbound_idx;
CREATE INDEX visitor_images_unbound_idx ON visitor_images (created_at) WHERE message_id IS NULL AND test_execution_id IS NULL;
