# Quickstart: Website Embed Widget

## Goal

Validate that a workspace operator can enable website embed, install the launcher on an approved site, open the hosted iframe assistant, and safely reject unapproved origins.

## Preconditions

1. Backend and frontend are running locally.
2. A test workspace exists with at least one accessible document or a usable base assistant configuration.
3. The operator can access General Settings for that workspace.
4. Two local web origins are available for validation:
   - one approved origin
   - one unapproved origin

## Operator Setup

1. Open the workspace General Settings page.
2. Enable website embed.
3. Add the approved origin to the allowlist.
4. Set a launcher label and position.
5. Copy the generated install snippet.

## Approved-Origin Validation

1. Add the install snippet to a page served from the approved origin.
2. Load the page in a browser.
3. Confirm the launcher appears in the configured position.
4. Open the launcher and confirm the embedded assistant loads inside the page.
5. Send a first message and confirm a response arrives.
6. Refresh the page and confirm embedded conversation continuity still works in the same browser.

## Unapproved-Origin Validation

1. Add the same snippet to a page served from an origin not present in the allowlist.
2. Load the page.
3. Confirm the launcher fails safely with an unavailable or blocked state.
4. Confirm no usable embedded session is created for that origin.

## Disablement Validation

1. Return to General Settings and disable website embed.
2. Reload the approved-origin page.
3. Confirm new embedded launches are blocked with a user-friendly unavailable state.

## Documentation Validation

1. Verify the operator documentation explains:
   - how to enable website embed
   - how to configure approved origins
   - how the install snippet works
   - why the hosted iframe is the trust boundary

## Expected Outcome

- Approved origins can launch the embedded assistant.
- Unapproved origins are rejected safely.
- Operators can copy and reuse the install snippet from settings.
- The embedded assistant reuses the existing public-chat behavior rather than behaving like a separate product surface.
