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
  {
    code: 'invalid_var_declaration',
    content: '---\ngrammar: 1\nname: Intake\ntrigger: hi\nvars: tracking_id:numbre:optional\n---\nAsk for it.',
    line: 5,
    message: 'Invalid vars declaration "tracking_id:numbre:optional": unknown slot type "numbre"',
  },
  {
    code: 'duplicate_var_declaration',
    content: '---\ngrammar: 1\nname: Intake\ntrigger: hi\nvars: tracking_id:text, tracking_id:number\n---\nAsk for it.',
    line: 5,
    message: 'Duplicate vars declaration for "tracking_id"',
  },
  {
    code: 'invalid_guard_token',
    content: '---\ngrammar: 1\nname: Branch\ntrigger: hi\n---\n[if status ~~ paid] -> end',
    line: 6,
    message: 'Invalid guard token: [if status ~~ paid]',
  },
  {
    code: 'invalid_action_token',
    content: '---\ngrammar: 1\nname: Action\ntrigger: hi\n---\n[action ]',
    line: 6,
    message: 'Invalid action token: [action ]',
  },
  {
    code: 'invalid_gate_token',
    content: '---\ngrammar: 1\nname: Gate\ntrigger: hi\n---\n[decision route: yes]',
    line: 6,
    message: 'Invalid gate token: [decision route: yes]',
  },
  {
    code: 'invalid_target_token',
    content: '---\ngrammar: 1\nname: Target\ntrigger: hi\n---\n-> step:review/order',
    line: 6,
    message: 'Invalid target token: -> step:review/order',
  },
  {
    code: 'invalid_skill_binding_suffix',
    content: '---\ngrammar: 1\nname: Skill\ntrigger: hi\n---\n#lookup[in email]',
    line: 6,
    message: 'Invalid skill binding suffix for "#lookup": [in email]',
  },
  {
    code: 'conflicting_guard_and_counter',
    content: '---\ngrammar: 1\nname: Loop\ntrigger: hi\n---\n[if amount >= 100] -> step:earlier_step (max 2)',
    line: 6,
    message: 'Branch line combines a guard token with a counter limit; use "-> step:earlier_step (max 2)" without another guard for a bounded loop',
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
