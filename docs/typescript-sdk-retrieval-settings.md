# Radioso TypeScript SDK: Retrieval Settings

This guide explains when to change search and answer settings, what the main options do, and a safe starting point for most teams.

You do not need to touch these settings to get started. Most teams should first:

1. Upload documents
2. Run document search and chat
3. Review answer quality
4. Change these settings only when there is a clear problem to solve

## When To Change These Settings

Consider changing them when:

- answers are missing relevant context
- answers include too much weak or noisy context
- rewrite behavior is changing the meaning of user questions
- citations look right but the system is missing useful matches
- ranking is acceptable for some queries and poor for others in a repeatable way

Leave the defaults alone if results are already good enough.

## Read Current Settings

```ts
const settings = await client.settings.getRetrieval();
```

## Update Retrieval Settings

```ts
await client.settings.updateRetrieval({
  queryRewriteEnabled: true,
  semanticRewriteInstructions: "",
  lexicalRewriteInstructions: "",
  answerSupportPolicy: "strict",
  rerankEnabled: true,
  vectorTopK: 20,
  similarityThreshold: 0.2,
  rerankTopK: 20,
  citationDisplayEnabled: true,
  metadataRules: [],
  customInstruction: "",
});
```

## Recommended Starting Point

For most teams:

- `queryRewriteEnabled: true`
- `rerankEnabled: true`
- `vectorTopK: 20`
- `similarityThreshold: 0.2`
- `rerankTopK: 20`
- `answerSupportPolicy: "strict"`
- `citationDisplayEnabled: true`

This is a safe default: look for a good set of matches, reorder them, show citations, and stay conservative when the system is not confident.

## What The Main Settings Mean

### `queryRewriteEnabled`

Turns question rewriting on or off before search.

Recommendation:
- Keep this on unless rewrite is consistently distorting user intent.

### `semanticRewriteInstructions`

Extra guidance for meaning-based rewrite.

Recommendation:
- Leave empty unless you have a specific recurring rewrite failure.

### `lexicalRewriteInstructions`

Extra guidance for exact-word rewrite.

Recommendation:
- Leave empty unless exact-word matching keeps missing important wording.

### `answerSupportPolicy`

Controls how strict the system should be when the answer is not well supported by the documents it found.

Options:
- `strict`: safest default for most production use
- `warn`: useful when you still want an answer even when support is weak
- `off`: useful only when you do not want the system enforcing this check

Recommendation:
- Start with `strict`.

### `rerankEnabled`

Reorders the matches after the first search pass.

Recommendation:
- Keep this on unless you are debugging the raw search results.

### `vectorTopK`

Controls how many meaning-based matches are pulled in before later filtering and reordering.

Recommendation:
- Start at `20`.
- Increase if relevant evidence is often missing.
- Decrease if context is consistently noisy.

### `similarityThreshold`

Sets the minimum similarity score a match must have before it is kept.

Recommendation:
- Start at `0.2`.
- Raise it if low-quality matches are slipping through.
- Lower it only if the search is too narrow and clearly dropping useful matches.

### `rerankTopK`

Controls how many matches continue into the reorder step.

Recommendation:
- Start at `20`.
- Increase only if you have enough useful candidates to justify it.

### `citationDisplayEnabled`

Controls whether citations are included in responses.

Recommendation:
- Keep this on for debugging, evaluation, and most document-backed answers.

### `metadataRules`

Applies metadata-based rules such as filtering or boosting.

Recommendation:
- Use only when your metadata is clean and consistently populated.
- Avoid adding rules until you can explain exactly which search problem they solve.

### `customInstruction`

Custom answer-writing instructions for this account or team.

Recommendation:
- Keep this brief and specific.
- Do not use it to compensate for poor document quality or weak search settings.

## Practical Tuning Advice

- Change one setting family at a time.
- Test with a stable set of representative queries.
- Prefer small adjustments before large jumps.
- If search results are poor, inspect the documents and chunking before over-tuning search settings.
- If answers are going beyond what the documents actually say, check `answerSupportPolicy` and `similarityThreshold` first.
