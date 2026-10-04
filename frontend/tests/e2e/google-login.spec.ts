import { expect, test } from '@playwright/test'

// Google sends the browser to <APP_BASE_URL>/api/v1/ee/auth/google/callback, a
// path the dashboard serves only because next.config.mjs rewrites it onto the
// /backend proxy. The unit test in tests/unit/next-config-security.test.ts
// pins the config object; this pins the fact a running server actually
// resolves the path, which is how the route went missing in the first place.
const CALLBACK_PATH = '/api/v1/ee/auth/google/callback?code=test-code&state=test-state'

// The same shape with no rewrite behind it, so the assertions below are read
// against a live example of what an unrouted path looks like on this server.
const UNROUTED_PATH = '/api/v1/ee/auth/absent/callback'

const NEXT_NOT_FOUND_MARKER = 'This page could not be found'

test.describe('google login callback rewrite', () => {
  // `maxRedirects: 0` because a reachable backend answers the callback with a
  // redirect to the app, and following it would leave the server under test.
  test('resolves the callback path instead of serving Next’s 404', async ({ request }) => {
    const response = await request.get(CALLBACK_PATH, { maxRedirects: 0 })

    expect(response.headers()['content-type'] ?? '').not.toContain('text/html')
    expect(await response.text()).not.toContain(NEXT_NOT_FOUND_MARKER)
  })

  test('serves Next’s 404 for a sibling path with no rewrite', async ({ request }) => {
    const response = await request.get(UNROUTED_PATH, { maxRedirects: 0 })

    expect(response.status()).toBe(404)
    expect(response.headers()['content-type'] ?? '').toContain('text/html')
    expect(await response.text()).toContain(NEXT_NOT_FOUND_MARKER)
  })
})

test.describe('failed google sign-in', () => {
  // The callback bounces the browser back to the login page carrying the
  // error in the query string; nothing else on the page says what happened.
  test('reports the failure on the login page', async ({ page }) => {
    await page.route('**/backend/api/v1/auth/session', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'unauthorized', message: 'Unauthorized' } }),
      }),
    )
    await page.route('**/backend/api/v1/auth/registration', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ available: true }),
      }),
    )

    await page.goto('/?error=google_login_failed')

    await expect(page.getByText('Google sign-in did not complete. Try again.')).toBeVisible()
  })
})
