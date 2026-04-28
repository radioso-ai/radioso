# Answer support validation

## Summary

Check generated answers against retrieved evidence before showing the final response.

## Details

When this is on, Radioso validates answer segments against the retrieved context. Unsupported segments can be removed or replaced with a grounded unsupported-answer response.

Turn this off when you want to inspect the model's raw retrieval-backed answer without the final validation pass.
