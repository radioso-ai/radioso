# Quickstart: Safe Markdown Chat Answers

## Verify the feature locally

1. Install frontend dependencies in `frontend/`.
2. Run the frontend unit tests focused on markdown chat rendering.
3. Open the chat UI and confirm assistant answers render paragraphs, lists, code blocks, links, and citations together.

## Suggested checks

- Confirm live chat answers render the markdown subset without changing citation placement.
- Confirm chat history reuses the same assistant answer renderer.
- Confirm raw HTML and unsafe links do not become active content.

## Notes

- No backend migration, API contract update, or storage migration is required.
- The feature is complete when the shared assistant message renderer behaves the same across the live chat, anonymous chat, and history views.
