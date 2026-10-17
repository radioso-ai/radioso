import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

test('the static export includes the generated llms.txt connect references', async () => {
  const text = await readFile(path.join(process.cwd(), 'out', 'llms.txt'), 'utf8')

  assert.match(text, /\[Connect a calling agent\]\(https:\/\/docs\.radioso\.ai\/guides\/agent-converse\)/)
  assert.match(text, /\[Agent converse API\]\(https:\/\/docs\.radioso\.ai\/api\/agent-converse\)/)
})
