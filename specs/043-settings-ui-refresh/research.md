# Research: Settings UI Refresh

## Design Review Findings

### Decision: Reorganize settings around operator tasks, not backend stages alone

**Rationale**: The current settings experience is split into tabs, but within those tabs the layout often assumes the operator already understands the implementation model. `general-tab.tsx` reads as a long stack of unrelated sections, while ingestion and retrieval expose a pipeline motif before they establish a clear “what should I do here?” mental model. A stronger local navigation layer and clearer section grouping reduce scan cost without changing behavior.

**Alternatives considered**:

- Keep the current pages and only polish spacing. Rejected because the primary issue is navigation and hierarchy, not just visual density.
- Collapse everything into one mega settings page. Rejected because it would increase scroll cost and work against existing route state and tab separation.

### Decision: Use reusable settings tab metadata plus a shared shell

**Rationale**: The same problems exist across general, ingestion, and retrieval. A small metadata layer for tab summaries and sections gives one source of truth for local navigation, anchor labels, and tests. A shared tab shell prevents three large panel files from each growing their own bespoke navigation layout.

**Alternatives considered**:

- Hard-code section links inside each panel. Rejected because it duplicates logic and makes anchor behavior harder to test consistently.
- Put all metadata directly in `settings-view.tsx`. Rejected because it would turn the top-level orchestrator into another god file.

### Decision: Keep retrieval and ingestion save actions persistent inside the viewport

**Rationale**: Those tabs are long-form tuning surfaces with a single save action. A sticky or persistent save area lowers the cost of editing multiple controls and directly addresses the current need to scroll back to the top.

**Alternatives considered**:

- Keep save buttons only in the header. Rejected because they disappear during long editing sessions.
- Save on every keystroke/change. Rejected because current behavior is explicit-save and changing that interaction would expand scope.

## CEO Review

### Decision: Approve a selective expansion, not a broad settings rewrite

**Mode**: SELECTIVE EXPANSION

**Approved direction**:

- Strengthen information architecture inside the existing tabs.
- Add a strong section index and better tab-level summaries.
- Improve operator confidence in high-complexity tabs by grouping controls into outcome-based sections.
- Preserve the existing dark visual language rather than chasing a brand-new look.

**Rejected expansions**:

- No new onboarding wizard for settings.
- No backend-generated recommendations or “auto tune” feature.
- No changes to settings storage or contracts.

**Reasoning**: The 10-star version of this work is not “more features in Settings”; it is a settings UI that makes current capabilities legible and fast to operate. That is a lake worth boiling in one pass.
