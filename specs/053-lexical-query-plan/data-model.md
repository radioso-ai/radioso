# Data Model: Structured Lexical Query Plans

## Lexical Alternative

Represents one executable lexical search option derived from model output.

Fields:
- `label`: Human-readable branch label for diagnostics.
- `lexicalQuery`: Normalized lexical query string for the active backend.
- `semanticQuery`: Existing semantic query paired with this alternative.
- `reason`: Optional explanation from the rewrite step.

Validation rules:
- Must contain at least one searchable term or phrase.
- Must be below branch and length limits.
- Must not rely on raw backend-specific syntax as executable authority.

## Lexical Alternative Set

Represents the bounded collection of alternatives for one user turn.

Fields:
- `alternatives`: Ordered list of normalized lexical alternatives.
- `fallbackQuery`: Existing lexical query used when alternatives are unavailable or invalid.
- `fallbackReason`: Reason alternatives were not used, when applicable.

Validation rules:
- Maximum branch count is bounded by retrieval behavior limits.
- Duplicate alternatives are removed case-insensitively.
- Empty alternatives are dropped.

## Existing Retrieval Subquery

The feature maps lexical alternatives into the existing retrieval subquery concept.

Fields reused:
- `id`
- `label`
- `semanticQuery`
- `lexicalQuery`
- `reason`
- `responseLanguagePolicy`

Contract rule:
- No new required fields are added to retrieval pipeline stage contracts.
