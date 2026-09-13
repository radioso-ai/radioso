# Quickstart: Confirmed Operator MCP Authoring

1. Build the backend and Operator MCP package from a clean checkout.
2. Use a disposable integration database and a grant that explicitly includes
   `operator:read`, `operator:propose`, and `operator:write`.
3. Read a routine, prepare an explicit transform, inspect its connections and
   diagnostics, then call execution with the returned reviewed identity only
   after the test client has recorded confirmation. Re-read the routine and
   verify its draft changed while published behavior did not.
4. Read system defaults and agent retrieval state. Prepare/apply a partial
   agent patch; verify omitted values remain unchanged and defaults remain
   read-only.
5. Prepare a candidate, inspect its validation/diff, then separately confirm
   publication. Verify a new conversation selects it and an existing one
   retains its prior revision.
6. Retry each completed execution and query its outcome; verify one mutation.
   Retry after a target fence changes and verify rejection.
