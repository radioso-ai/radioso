# Data Model: Hybrid Retrieval

## 1. Retrieval Settings

Account-scoped configuration used by retrieval, ingestion, and operator-facing retrieval controls.

### Fields

- `accountId`: Unique account identifier
- `queryRewriteEnabled`: Existing retrieval preference
- `rerankEnabled`: Existing retrieval preference
- `vectorTopK`: Existing retrieval preference
- `similarityThreshold`: Existing retrieval preference
- `rerankTopK`: Existing retrieval preference
- `warmthLevel`: Existing response preference
- `citationDisplayEnabled`: Existing response preference
- `chunkingStrategy`: Existing ingest-time chunking selection
- `attributeControls`: List of supported attribute-family controls
- `createdAt`: Creation timestamp
- `updatedAt`: Last update timestamp

### Validation Rules

- `attributeControls` contains at most one control per supported family
- Every supported family has a default control when settings are created or loaded
- `mode` must be one of `boost_only` or `hard_filter`
- A family marked disabled cannot participate in boosting or hard filtering

### Notes

- Controls are account-scoped and affect only future retrieval behavior for that account
- The first release supports only `date_point`, `date_range`, `money_value`, and `location`

## 2. Attribute-Family Retrieval Control

Operator-defined retrieval behavior for one supported attribute family.

### Fields

- `family`: Supported attribute family identifier
- `enabled`: Whether the family participates in retrieval at all
- `mode`: `boost_only` or `hard_filter`

### Validation Rules

- `family` is unique within one account’s control set
- Unsupported family identifiers are rejected safely
- `hard_filter` can be selected only as an allowed mode; confidence gating still applies at runtime

## 3. Chunk Search Record

Persisted retrieval unit for one chunk after hybrid-ingest enrichment.

### Fields

- `chunkId`: Unique chunk identifier
- `documentId`: Owning document identifier
- `accountId`: Owning account identifier
- `chunkIndex`: Ordered chunk position within the document
- `content`: Stored chunk body text
- `searchText`: Normalized retrieval representation used for lexical retrieval, embeddings, rerank enrichment, or all three
- `attributes`: Normalized structured-attribute payload for supported families
- `embedding`: Vector embedding for semantic retrieval
- `startOffset`: Inclusive source start position
- `endOffset`: Exclusive source end position
- `createdAt`: Persistence timestamp

### Validation Rules

- `searchText` must not be empty when `content` is present
- `searchText` is rendered in stable order from title, available hierarchy context, concise attribute text, and chunk body
- `attributes` must use normalized comparison forms for supported families
- Existing chunk ordering and citation offsets remain unchanged

## 4. Structured Attribute Payload

Normalized supported attribute values attached to one chunk.

### Fields

- `datePoints`: Zero or more normalized single-date values
- `dateRanges`: Zero or more normalized start/end date ranges
- `moneyValues`: Zero or more normalized monetary values
- `locations`: Zero or more normalized location values

### Validation Rules

- Every value includes a `confidence` score
- Every value includes enough normalized data for comparison in retrieval logic
- Families may be empty for chunks that do not contain supported literals

### Notes

- The first release keeps these values deterministic and bounded
- The payload is a retrieval aid, not a user-defined schema surface

## 5. Normalized Date Point

### Fields

- `value`: Canonical calendar value
- `granularity`: Date precision used by comparison logic
- `confidence`: Extraction confidence
- `sourceText`: Original matching text

### Validation Rules

- Equivalent dates normalize to the same comparison form
- Low-confidence date points cannot force hard filtering on their own

## 6. Normalized Date Range

### Fields

- `start`: Canonical range start
- `end`: Canonical range end
- `confidence`: Extraction confidence
- `sourceText`: Original matching text

### Validation Rules

- `start` is not after `end`
- Overlap checks use normalized start/end values

## 7. Normalized Money Value

### Fields

- `amount`: Canonical numeric amount
- `currencyCode`: Normalized currency identifier when known
- `confidence`: Extraction confidence
- `sourceText`: Original matching text

### Validation Rules

- Equivalent amounts and currency variants normalize consistently
- Unknown or ambiguous currency values remain boost-only unless confidence rules explicitly allow otherwise

## 8. Normalized Location Value

### Fields

- `matchKey`: Canonical location comparison key
- `displayName`: Human-readable normalized name
- `confidence`: Extraction confidence
- `sourceText`: Original matching text

### Validation Rules

- Equivalent text forms normalize to the same `matchKey`
- The first release uses text normalization rather than mandatory geocoding

## 9. Parsed Query Interpretation

Query-time retrieval understanding used by hybrid retrieval.

### Fields

- `semanticQuery`: Query text sent to semantic retrieval
- `lexicalQuery`: Query text sent to lexical retrieval
- `constraints`: Parsed supported constraints
- `boosts`: Parsed supported soft preferences
- `sortIntent`: Optional ordering intent when present

### Validation Rules

- Supported constraints use the same normalized comparison form as stored attributes
- Each parsed constraint includes confidence
- Unsupported or low-confidence interpretations degrade safely

## 10. Parsed Query Constraint

### Fields

- `family`: Supported attribute family
- `operator`: Supported comparison such as overlap, before, after, less-than-or-equal, greater-than-or-equal, or exact match
- `value`: Normalized comparison value
- `confidence`: Parsing confidence

### Validation Rules

- Only supported operators are allowed per family
- `hard_filter` behavior is allowed only when both the account control and confidence rules permit it

## 11. Hybrid Candidate

Merged candidate record produced before reranking.

### Fields

- `chunkId`: Candidate chunk identifier
- `documentId`: Owning document identifier
- `title`: Document title
- `content`: Chunk body text
- `searchText`: Enriched retrieval text
- `attributes`: Structured attribute payload
- `retrievalSources`: Set of contributing sources such as semantic or lexical
- `semanticScore`: Best available semantic similarity
- `lexicalScore`: Best available lexical rank score
- `attributeMatchScore`: Score contribution from supported attribute matching
- `filterOutcome`: Whether the candidate passed, was boosted, or was excluded by supported constraints

### Validation Rules

- `chunkId` is the deduplication boundary
- Duplicate candidates from different sources collapse into one record with retained provenance
- Candidates excluded by hard-filter logic do not reach reranking

## 12. Retrieval Information View Model

Operator-facing retrieval summary attached to one executed chat answer.

### Fields

- `parsedQuery`: Bounded description of semantic and supported constraint interpretation
- `candidateCounts`: Counts by retrieval source and post-merge stage
- `appliedConstraints`: Supported constraints used as hard filters or boosts
- `fallbackApplied`: Whether fallback behavior changed the retrieval plan
- `rerankStatus`: Rerank application status

### Validation Rules

- View data is bounded and readable in product language
- Sensitive raw internals and full logs are excluded

## 13. State Transitions

### Ingest-Time Hybrid Enrichment

1. Document create or update request received
2. Active retrieval settings loaded
3. Chunking strategy resolves and produces chunk outputs
4. `searchText` renders for each chunk
5. Supported attributes are extracted and normalized for each chunk
6. Embeddings are generated from normalized retrieval text
7. Chunk search record is persisted with `searchText`, attributes, and embedding

### Query-Time Hybrid Retrieval

1. Query rewrite and context selection run as configured
2. Supported query constraints are parsed and normalized
3. Semantic and lexical candidate sets are generated
4. Hybrid candidates merge and deduplicate by chunk id
5. Supported constraints filter or boost candidates according to controls and confidence
6. Fallback relaxes hard filters when required
7. Reranking selects final prompt contexts
8. Retrieval information view data is created for audit and UI use
