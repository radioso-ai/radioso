# Data Model: Persistent Dashboard Links

## Dashboard Location State

- **Purpose**: Canonical description of a revisit-worthy dashboard destination.
- **Fields**:
  - `section`: Top-level dashboard section.
  - `workspaceId`: Workspace to activate before rendering workspace-scoped content.
  - `documentId`: Selected document detail target in the Documents section.
  - `documentsPage`: Current paginated page for the Documents section.
  - `historyFilter`: Active History mode (`all`, `chat`, or `search`).
  - `historyPage`: Current paginated page for the active History filter.
  - `historyItemKind`: Selected History detail kind (`chat` or `search`).
  - `historyItemId`: Selected History detail identifier.
  - `settingsTab`: Active Settings tab.
  - `settingsAnchor`: Supported section anchor within the active Settings tab.
  - `connectorId`: Selected connector inside the Chat Connectors tab.

## Section-Specific Link State

### Documents Link State

- **Purpose**: Reopen a document list page or a selected document detail view.
- **Fields**:
  - `documentsPage`
  - `documentId`
- **Rules**:
  - `documentsPage` is optional and defaults to the first page.
  - `documentId` can coexist with `documentsPage` so closing the detail returns to the same list page.

### History Link State

- **Purpose**: Reopen a History filter, page, and selected detail drawer.
- **Fields**:
  - `historyFilter`
  - `historyPage`
  - `historyItemKind`
  - `historyItemId`
- **Rules**:
  - `historyPage` applies to the active filter only.
  - Detail state is valid only when both `historyItemKind` and `historyItemId` are present.

### Settings Link State

- **Purpose**: Reopen a specific settings tab, anchor, or connector detail.
- **Fields**:
  - `settingsTab`
  - `settingsAnchor`
  - `connectorId`
- **Rules**:
  - `connectorId` is meaningful only when the active tab is `connectors`.
  - `settingsAnchor` must reference a supported stable section id.

## Safe Fallback Destination

- **Purpose**: Normalize invalid, stale, or incompatible location state into a usable dashboard destination.
- **Rules**:
  - Invalid sections fall back to the default dashboard section.
  - Invalid pages fall back to the closest valid page.
  - Invalid tabs, anchors, selected items, or connector ids are dropped while keeping the surrounding section open.
  - Missing or invalid workspace ids fall back to the active accessible workspace.
