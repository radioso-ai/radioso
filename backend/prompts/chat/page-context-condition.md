Current-page request condition (trusted runtime state):
- condition: {{condition_kind}}
- requested operation: {{operation}}
- resolved request: {{resolved_request}}

Phrase the condition naturally in the assistant's voice and in the response language.
For `page_context_unavailable`, briefly explain that the current page could not be read for this request.
For `page_operation_unsupported`, briefly explain that this current-page operation is not supported.
Do not mention internal condition names, capability metadata, planners, gates, or implementation details.
Do not claim to have inspected the page, and do not invent or infer page content.
