# Quickstart: Persistent Dashboard Links

## Validation Setup

1. Start the frontend app.
2. Sign in to an account with access to multiple workspaces.
3. Ensure the account has:
   - enough documents to paginate the Documents view
   - saved chat or search history
   - at least one registered connector

## Validation Scenarios

### Documents

1. Open Documents and move to a non-default page.
2. Open a document from that page.
3. Refresh the browser.
4. Confirm the same workspace, documents page, and document detail reopen.

### History

1. Open History and switch to each supported filter.
2. Move to a non-default page for a filter.
3. Open a saved conversation or saved search.
4. Refresh the browser.
5. Confirm the same workspace, filter, page, and detail drawer reopen.

### Settings

1. Open Settings and switch to each supported tab.
2. Navigate directly to at least one supported anchor in General, Ingestion, Retrieval, and Connectors.
3. Select a connector in Chat Connectors.
4. Refresh the browser.
5. Confirm the same workspace, tab, anchor, and connector selection reopen.

### Safe Fallbacks

1. Manually edit the URL to use an invalid page, tab, anchor, or item id.
2. Reload the dashboard.
3. Confirm the dashboard stays usable and falls back to the nearest safe supported state.

## Automated Validation

1. Run `npm test` from `frontend/`.
2. Run `npm run lint` from `frontend/`.
3. Run `npm run build` from `frontend/`.
