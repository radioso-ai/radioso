-- The second of three steps widening conversation_activity.kind (211): checks the existing rows against
-- the v2 CHECK, which every row already satisfies, since v1 allows a subset of it.
--
-- Locks. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE for the scan, which no read or write waits
-- for, so the scan needs no time bound. A separate migration from 211, so 211's ACCESS EXCLUSIVE was
-- released when it committed, before this scan begins.
ALTER TABLE conversation_activity
  VALIDATE CONSTRAINT conversation_activity_kind_v2_check;
