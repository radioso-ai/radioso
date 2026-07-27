// Captures the dashboard screenshots used by the docs portal.
//
// Prerequisites:
//   1. A running local stack (./run-dev.sh) with a seeded demo workspace.
//      The demo data this script expects (org "Aurora Coffee Roasters",
//      workspace "Customer Support", agent "Aurora Support" with four
//      processed documents, one directive, one published routine, and one
//      conversation) can be created through the normal API flows described
//      in docs-portal/content/quickstarts/api-first-success.mdx.
//   2. Playwright installed (the frontend workspace already depends on it):
//      pnpm --dir frontend exec playwright install chromium
//
// Usage (run from the frontend workspace so Playwright resolves):
//   cd frontend
//   RADIOSO_APP_URL=http://localhost:3000 \
//   RADIOSO_DEMO_EMAIL=demo@example.com \
//   RADIOSO_DEMO_PASSWORD=... \
//   RADIOSO_WORKSPACE_KEY=<workspace public route key> \
//   RADIOSO_DEMO_AGENT_ID=<agent uuid> \
//   RADIOSO_DEMO_ROUTINE_ID=<routine uuid> \
//   RADIOSO_DEMO_CONVERSATION_ID=<conversation uuid> \
//   node ../docs-portal/scripts/capture-screenshots.mjs
//
// Output: docs-portal/public/screenshots/*.png at a 1440x900 viewport.
// Retake shots in the same change that alters the screens they show.

import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const requireFromCwd = createRequire(join(process.cwd(), 'package.json'))
const playwright = await import(pathToFileURL(requireFromCwd.resolve('@playwright/test')))
const chromium = playwright.chromium ?? playwright.default.chromium

const env = (name, fallback) => process.env[name] ?? fallback
const APP = env('RADIOSO_APP_URL', 'http://localhost:3000')
const EMAIL = env('RADIOSO_DEMO_EMAIL')
const PASSWORD = env('RADIOSO_DEMO_PASSWORD')
const WS_KEY = env('RADIOSO_WORKSPACE_KEY')
const AGENT_ID = env('RADIOSO_DEMO_AGENT_ID')
const ROUTINE_ID = env('RADIOSO_DEMO_ROUTINE_ID')
const CONVERSATION_ID = env('RADIOSO_DEMO_CONVERSATION_ID')

for (const [name, value] of Object.entries({ RADIOSO_DEMO_EMAIL: EMAIL, RADIOSO_DEMO_PASSWORD: PASSWORD, RADIOSO_WORKSPACE_KEY: WS_KEY, RADIOSO_DEMO_AGENT_ID: AGENT_ID })) {
  if (!value) {
    console.error(`Missing required env var ${name}`)
    process.exit(1)
  }
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'screenshots')
mkdirSync(outDir, { recursive: true })

const ws = (path) => `${APP}/w/${WS_KEY}${path}`

// `action` runs after navigation and before the screenshot. Keep actions on
// visible-label selectors so routing internals can change without breaking
// the captures.
const askInWorkbench = async (page) => {
  const input = page.getByPlaceholder('Ask a question...')
  await input.fill('How long does shipping to Germany take, and is it free?')
  await input.press('Enter')
  // Wait for the streamed grounded answer (citations chip) to land.
  await page.getByText('Sources', { exact: false }).first().waitFor({ timeout: 90000 })
  await page.waitForTimeout(2000)
}

const openDirectives = async (page) => {
  await page.getByText('Directives', { exact: true }).first().click()
  await page.waitForTimeout(2000)
}

const shots = [
  { name: 'dashboard-agents-workbench.png', url: ws(`/agents/${AGENT_ID}?tab=chat`), settle: 3000, action: askInWorkbench },
  { name: 'dashboard-knowledge-documents.png', url: ws('/documents'), settle: 2000 },
  { name: 'dashboard-agent-behavior.png', url: ws(`/agents/${AGENT_ID}?tab=behavior`), settle: 2000 },
  { name: 'dashboard-agent-directives.png', url: ws(`/agents/${AGENT_ID}?tab=behavior`), settle: 2000, action: openDirectives },
  ...(ROUTINE_ID ? [{ name: 'dashboard-routine-editor.png', url: ws(`/agents/${AGENT_ID}/routines/${ROUTINE_ID}`), settle: 2500 }] : []),
  { name: 'dashboard-activity.png', url: ws('/history?tab=all'), settle: 2000 },
  { name: 'dashboard-settings.png', url: ws('/settings'), settle: 2000 },
  { name: 'dashboard-eval.png', url: ws('/eval'), settle: 2000 },
  { name: 'dashboard-agent-channels.png', url: ws(`/agents/${AGENT_ID}?tab=channels`), settle: 2000 },
]

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })

console.log('Signing in…')
await page.goto(APP, { waitUntil: 'networkidle' })
await page.fill('input[type="email"]', EMAIL)
await page.fill('input[type="password"]', PASSWORD)
await page.click('button[type="submit"]')
await page.waitForURL('**/w/**', { timeout: 30000 })

for (const shot of shots) {
  console.log(`Capturing ${shot.name}`)
  await page.goto(shot.url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(shot.settle)
  if (shot.action) {
    await shot.action(page)
  }
  await page.screenshot({ path: join(outDir, shot.name) })
}

await browser.close()
console.log(`Done. Screenshots in ${outDir}`)
