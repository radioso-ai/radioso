# Data Model: Settings UI Refresh

## Overview

This feature introduces frontend-only view models that describe settings tab structure and section navigation. No database schema or backend payload changes are required.

## Entities

### SettingsTabDescriptor

- **Represents**: The metadata needed to render one settings tab consistently.
- **Fields**:
  - `id`: existing `SettingsTab` value
  - `title`: tab-level heading shown in the content area
  - `summary`: short explanation of the tab’s purpose
  - `sections`: ordered list of `SettingsSectionDescriptor`

### SettingsSectionDescriptor

- **Represents**: A navigable section inside a settings tab.
- **Fields**:
  - `id`: DOM anchor / route anchor value
  - `label`: section name shown in the local section index
  - `summary`: short helper copy used in the navigation rail or compact mobile list

### SettingsSaveState

- **Represents**: UI state for long-form tabs with explicit save behavior.
- **Fields**:
  - `hasChanges`: whether the current draft differs from the last saved value
  - `isSaving`: whether a save or save-related action is in progress
  - `saveLabel`: context-specific action label such as `Save changes`
  - `secondaryAction`: optional extra action such as reprocess

## Relationships

- One `SettingsTabDescriptor` contains many `SettingsSectionDescriptor` values.
- `SettingsSaveState` belongs to a single rendered tab panel at a time.

## Validation Rules

- Section ids must match existing DOM anchor ids used by the panel content.
- Tab descriptors must only reference supported settings tabs.
- Section order is stable and determines rendered navigation order.

## State Transitions

- Settings tab renders with descriptor metadata.
- User selects a section from the local index.
- Route anchor updates and the content scrolls to the matching section.
- For long-form tabs, save state transitions between idle, changed, and saving without altering persistence behavior.
