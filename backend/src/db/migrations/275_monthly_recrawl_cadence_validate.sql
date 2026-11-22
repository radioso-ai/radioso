-- Monthly website recrawl, second step: proves the existing rows against the CHECK 274 added NOT
-- VALID. A separate file from 274, so 274's ACCESS EXCLUSIVE lock was released when it committed.
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE for its scan, which no read or write waits for,
-- so like 271 it needs no time bound.
ALTER TABLE document_sources VALIDATE CONSTRAINT document_sources_recrawl_cadence_check;
