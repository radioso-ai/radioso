# Quickstart: Split Semantic And Lexical Query Rewrite

## Scenario 1: Load retrieval settings for an existing workspace

1. Start the backend with a workspace that has older retrieval settings and no split rewrite instruction fields saved yet.
2. Request `GET /api/v1/settings/retrieval`.
3. Confirm the response still includes `queryRewriteEnabled`.
4. Confirm the response also includes `semanticRewriteInstructions` and `lexicalRewriteInstructions`.
5. Confirm the returned instruction fields use safe defaults instead of failing or returning an unusable payload.

## Scenario 2: Save split rewrite instructions from the settings UI

1. Open the Settings view and navigate to `Retrieval`.
2. Turn on query rewrite if it is currently disabled.
3. Enter distinct semantic and lexical rewrite instructions.
4. Save the settings.
5. Reload the page and confirm the saved instruction values and toggle state are preserved.

## Scenario 3: Use different semantic and lexical queries during retrieval

1. Prepare a workspace corpus where the indexed text uses a lexical notation variant, alias, or citation form.
2. Configure lexical rewrite instructions to prefer the corpus-native form while keeping semantic rewrite meaning-preserving.
3. Run a retrieval-backed chat query whose user wording differs from the indexed lexical form.
4. Inspect retrieval diagnostics or covered tests.
5. Confirm the active semantic query and active lexical query are both shown and differ when appropriate.

## Scenario 4: Use split rewrite on a standalone search with no history

1. Prepare a workspace corpus where indexed text uses legal citation notation or another corpus-native lexical form.
2. Configure semantic and lexical rewrite instructions, and enable query rewrite.
3. Run a standalone retrieval request with no prior conversation history, such as a document search for a citation-like query.
4. Inspect retrieval diagnostics or covered tests.
5. Confirm the semantic query may remain close to the original wording while the lexical query adopts the corpus-native notation.

## Scenario 5: Fall back safely when rewrite output is unusable

1. Simulate a rewrite response that returns an empty query or otherwise unusable output for one or both retrieval modes.
2. Run retrieval with query rewrite enabled.
3. Confirm the request still completes without retrieval failure.
4. Confirm the effective semantic and lexical queries fall back safely.
5. Confirm retrieval trace output records the fallback or rejection reason.
