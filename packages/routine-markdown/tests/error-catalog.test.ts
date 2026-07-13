import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parse } from '../src/index.js'

const diagnosticCases = [
  {
    code: 'unsupported_grammar_version',
    content: '---\ngrammar: 2\nname: Greeter\ntrigger: hi\n---\nAsk @email.',
    line: 2,
    message: 'Unsupported routine grammar version: 2',
  },
  {
    code: 'invalid_reentry',
    content: '---\ngrammar: 1\nname: Greeter\ntrigger: hi\nreentry: later\n---\nAsk @email.',
    line: 5,
    message: 'Unsupported routine reentry mode: later',
  },
  {
    code: 'invalid_priority',
    content: '---\ngrammar: 1\nname: Greeter\ntrigger: hi\npriority: high\n---\nAsk @email.',
    line: 5,
    message: 'Routine priority must be an integer: high',
  },
  {
    code: 'unknown_frontmatter_key',
    content: '---\ngrammar: 1\nname: Greeter\ntrigger: hi\nowner: support\n---\nAsk @email.',
    line: 5,
    message: 'Unknown routine frontmatter key: owner',
  },
  {
    code: 'unknown_bracket_token',
    content: '---\ngrammar: 1\nname: Greeter\ntrigger: hi\n---\n[foo bar] -> end',
    line: 6,
    message: 'Unknown routine bracket token: [foo bar]',
  },
  {
    code: 'invalid_export',
    content: '---\ngrammar: 1\nname: Export\ntrigger: hi\nexport: email -> dest\n---\nFinish.',
    line: 5,
    message: 'Routine export must be "<triggerKinds> -> <destinationRef>" with trigger kinds complete and/or handoff',
  },
] as const

describe('parse diagnostic catalog', () => {
  for (const diagnostic of diagnosticCases) {
    it(`emits ${diagnostic.code}`, () => {
      expect(parse(diagnostic.content)).toEqual({
        ok: false,
        diagnostics: [{
          line: diagnostic.line,
          code: diagnostic.code,
          message: diagnostic.message,
        }],
      })
    })
  }

  it('documents every diagnostic code in the normative grammar catalog', () => {
    const doc = readFileSync(resolve(import.meta.dirname, '../../../docs/portable-routine-markdown.md'), 'utf8')

    for (const diagnostic of diagnosticCases) {
      expect(doc).toContain(`\`${diagnostic.code}\``)
    }
  })
})
