import { describe, expect, it } from 'vitest'

import {
  GRAMMAR_VERSION,
  canonicalize,
  draftFromChipDoc,
  looksLikeRoutineProse,
  parse,
  parseProseDoc,
  serializeProseDoc,
} from '../src/index.js'
import { OUTCOME_GUARD_REF, SLOT_FILLED_GUARD_REF, type ChipDocVariable, type ProseParagraph } from '../src/index.js'

// A round-trip projects through text and back. The token grammar carries a variable's
// key + type but not its display description, so reconstructed variables key off the id;
// we compare the functional shape (kinds, refs, ops, targets, bindings), not labels.
const roundTrip = (
  input: { name: string; trigger: string; variables: ChipDocVariable[]; paragraphs: ProseParagraph[] },
  skills: string[] = [],
) => {
  const text = serializeProseDoc(input)
  const parsed = parseProseDoc(text, (name) => skills.includes(name))
  return { text, parsed }
}

const chipShape = (paragraphs: ProseParagraph[]) =>
  paragraphs.map((paragraph) => ({
    heading: paragraph.headingLevel === 1,
    segments: paragraph.segments.map((segment) =>
      segment.kind === 'text'
        ? { kind: 'text', text: segment.text }
        : {
            kind: 'chip',
            chipKind: segment.chipKind,
            refId: segment.refId,
            op: segment.op ?? null,
            value: segment.value ?? null,
            values: segment.values ?? null,
            unit: segment.unit ?? null,
            counterLimit: segment.counterLimit ?? null,
            inputBindings: segment.inputBindings ?? {},
            outputAssignments: segment.outputAssignments ?? {},
            // 'typed' is the default mode and isn't emitted, so it round-trips as absent.
            mode: segment.mode && segment.mode !== 'typed' ? segment.mode : undefined,
          },
    ),
  }))

describe('routine prose token grammar', () => {
  it('emits grammar version frontmatter from serialize', () => {
    const text = serializeProseDoc({
      name: 'Versioned',
      trigger: 'when versioning matters',
      variables: [],
      paragraphs: [{ segments: [{ kind: 'text', text: 'Say hello.' }] }],
    })

    expect(text.split('\n').slice(0, 4)).toEqual([
      '---',
      `grammar: ${GRAMMAR_VERSION}`,
      'name: Versioned',
      'trigger: when versioning matters',
    ])
  })

  it('elides default activation frontmatter from serialize', () => {
    const text = serializeProseDoc({
      name: 'Defaults',
      trigger: 'when defaults apply',
      variables: [],
      paragraphs: [{ segments: [{ kind: 'text', text: 'Say hello.' }] }],
      reentryMode: 'once_per_conversation',
      priority: 0,
    })

    expect(text).not.toContain('\nreentry:')
    expect(text).not.toContain('\npriority:')
    expect(parse(text, { resolveSkill: () => false })).toMatchObject({
      ok: true,
      doc: {
        reentryMode: 'once_per_conversation',
        priority: 0,
      },
    })
  })

  it('preserves non-default activation frontmatter through parse and canonicalize', () => {
    const text = serializeProseDoc({
      name: 'Priority',
      trigger: 'when priority matters',
      variables: [],
      paragraphs: [{ segments: [{ kind: 'text', text: 'Escalate.' }] }],
      reentryMode: 'always',
      priority: 10,
    })

    expect(text.split('\n').slice(0, 6)).toEqual([
      '---',
      `grammar: ${GRAMMAR_VERSION}`,
      'name: Priority',
      'trigger: when priority matters',
      'reentry: always',
      'priority: 10',
    ])

    const parsed = parse(text, { resolveSkill: () => false })
    expect(parsed).toMatchObject({
      ok: true,
      doc: {
        reentryMode: 'always',
        priority: 10,
      },
    })

    const canonical = canonicalize(text, { resolveSkill: () => false })
    expect(canonical).toEqual({
      ok: true,
      grammarVersion: GRAMMAR_VERSION,
      content: text,
    })
  })

  it('accepts once as a default reentry alias and canonicalizes it away', () => {
    const input = '---\ngrammar: 1\nname: Greeter\ntrigger: hi\nreentry: once\n---\nAsk @email.'
    const parsed = parse(input, { resolveSkill: () => false })

    expect(parsed).toMatchObject({
      ok: true,
      doc: {
        reentryMode: 'once_per_conversation',
      },
    })

    const canonical = canonicalize(input, { resolveSkill: () => false })

    expect(canonical).toEqual({
      ok: true,
      grammarVersion: GRAMMAR_VERSION,
      content: '---\ngrammar: 1\nname: Greeter\ntrigger: hi\n---\nAsk @email.\n',
    })
  })

  it('rejects invalid reentry frontmatter with a typed diagnostic', () => {
    const parsed = parse('---\ngrammar: 1\nname: Greeter\ntrigger: hi\nreentry: later\n---\nAsk @email.', { resolveSkill: () => false })

    expect(parsed).toEqual({
      ok: false,
      diagnostics: [{
        line: 5,
        code: 'invalid_reentry',
        message: 'Unsupported routine reentry mode: later',
      }],
    })
  })

  it('rejects unknown frontmatter keys in routine documents with a typed diagnostic', () => {
    const parsed = parse('---\ngrammar: 1\nname: Greeter\ntrigger: hi\nowner: support\n---\nAsk @email.', { resolveSkill: () => false })

    expect(parsed).toEqual({
      ok: false,
      diagnostics: [{
        line: 5,
        code: 'unknown_frontmatter_key',
        message: 'Unknown routine frontmatter key: owner',
      }],
    })
  })

  it('rejects unknown bracket tokens inside routine documents with a typed diagnostic', () => {
    const parsed = parse('---\ngrammar: 1\nname: Greeter\ntrigger: hi\n---\n[foo bar] -> end', { resolveSkill: () => false })

    expect(parsed).toEqual({
      ok: false,
      diagnostics: [{
        line: 6,
        code: 'unknown_bracket_token',
        message: 'Unknown routine bracket token: [foo bar]',
      }],
    })
  })

  it('does not classify pasted non-routine prose as a routine only because of unknown frontmatter', () => {
    expect(looksLikeRoutineProse('---\nowner: support\n---\nordinary note')).toBe(false)
  })

  it('passes activation frontmatter into draftFromChipDoc authoring output', () => {
    const draft = draftFromChipDoc({
      name: 'Priority',
      trigger: 'when priority matters',
      variables: [],
      blocks: [{ text: 'Escalate.', chips: [] }],
      reentryMode: 'semantic',
      priority: 5,
    })

    expect(draft.activation).toMatchObject({
      triggerDescription: 'when priority matters',
      gateRef: null,
      reentryMode: 'semantic',
      priority: 5,
    })
  })

  it('emits and parses non-default terminal frontmatter', () => {
    const text = serializeProseDoc({
      name: 'Terminal copy',
      trigger: 'when terminal copy matters',
      variables: [],
      paragraphs: [{ segments: [{ kind: 'text', text: 'Finish.' }] }],
      terminals: {
        complete: { id: 'completed_custom', instruction: 'Close this out.' },
        handoff: { id: 'handoff_support', instruction: 'Bring in support.' },
      },
    })

    expect(text.split('\n').slice(0, 6)).toEqual([
      '---',
      `grammar: ${GRAMMAR_VERSION}`,
      'name: Terminal copy',
      'trigger: when terminal copy matters',
      'end: completed_custom ("Close this out.")',
      'handoff: handoff_support ("Bring in support.")',
    ])

    const parsed = parse(text, { resolveSkill: () => false })
    expect(parsed).toMatchObject({
      ok: true,
      doc: {
        terminals: {
          complete: { id: 'completed_custom', instruction: 'Close this out.' },
          handoff: { id: 'handoff_support', instruction: 'Bring in support.' },
        },
      },
    })
  })

  it('elides default terminal frontmatter when no message is set', () => {
    const text = serializeProseDoc({
      name: 'Terminal defaults',
      trigger: 'when defaults apply',
      variables: [],
      paragraphs: [{ segments: [{ kind: 'text', text: 'Finish.' }] }],
      terminals: {
        complete: { id: 'done', instruction: null },
        handoff: { id: 'handoff', instruction: null },
      },
    })

    expect(text).not.toContain('\nend:')
    expect(text).not.toContain('\nhandoff:')
    const parsed = parse(text, { resolveSkill: () => false })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect('terminals' in parsed.doc).toBe(false)
  })

  it('passes terminal frontmatter into draftFromChipDoc authoring output', () => {
    const draft = draftFromChipDoc({
      name: 'Terminal copy',
      trigger: 'when terminal copy matters',
      variables: [],
      blocks: [
        { text: 'Finish.', chips: [] },
        {
          text: 'Escalate.',
          chips: [{ kind: 'handoff', refId: 'handoff', label: 'handoff' }],
        },
      ],
      terminals: {
        complete: { id: 'completed_custom', instruction: 'Close this out.' },
        handoff: { id: 'handoff_support', instruction: 'Bring in support.' },
      },
    })

    expect(draft.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ toRef: 'completed_custom', guardKind: 'default' }),
      expect.objectContaining({ toRef: 'handoff_support', guardKind: 'llm' }),
    ]))
    expect(draft.terminals).toEqual([
      expect.objectContaining({ stableStepId: 'completed_custom', kind: 'complete', instruction: 'Close this out.' }),
      expect.objectContaining({ stableStepId: 'handoff_support', kind: 'handoff', instruction: 'Bring in support.' }),
    ])
  })

  it('emits and parses completion export frontmatter only when enabled', () => {
    const text = serializeProseDoc({
      name: 'Export',
      trigger: 'when export matters',
      variables: [],
      paragraphs: [{ segments: [{ kind: 'text', text: 'Finish.' }] }],
      completionExport: {
        enabled: true,
        triggerKinds: ['complete', 'handoff'],
        destinationRef: '55555555-5555-4555-8555-555555555555',
      },
    })

    expect(text.split('\n').slice(0, 5)).toEqual([
      '---',
      `grammar: ${GRAMMAR_VERSION}`,
      'name: Export',
      'trigger: when export matters',
      'export: complete,handoff -> 55555555-5555-4555-8555-555555555555',
    ])

    const parsed = parse(text, { resolveSkill: () => false })

    expect(parsed).toMatchObject({
      ok: true,
      doc: {
        completionExport: {
          enabled: true,
          triggerKinds: ['complete', 'handoff'],
          destinationRef: '55555555-5555-4555-8555-555555555555',
        },
      },
    })
  })

  it('rejects invalid completion export frontmatter with typed diagnostics', () => {
    const parsed = parse('---\ngrammar: 1\nname: Export\ntrigger: hi\nexport: complete,email -> \n---\nFinish.', { resolveSkill: () => false })

    expect(parsed).toEqual({
      ok: false,
      diagnostics: [{
        line: 5,
        code: 'invalid_export',
        message: 'Routine export must be "<triggerKinds> -> <destinationRef>" with trigger kinds complete and/or handoff',
      }],
    })
  })

  it('rejects malformed vars declarations with typed diagnostics on the vars line', () => {
    const parsed = parse([
      '---',
      `grammar: ${GRAMMAR_VERSION}`,
      'name: Intake',
      'trigger: hi',
      'vars: tracking-id:text, status:text:sticky',
      '---',
      'Ask for it.',
    ].join('\n'), { resolveSkill: () => false })

    expect(parsed).toEqual({
      ok: false,
      diagnostics: [
        {
          line: 5,
          code: 'invalid_var_declaration',
          message: 'Invalid vars declaration "tracking-id:text": invalid slot key "tracking-id"',
        },
        {
          line: 5,
          code: 'invalid_var_declaration',
          message: 'Invalid vars declaration "status:text:sticky": invalid flag "sticky"',
        },
      ],
    })
  })

  it('rejects duplicate vars declarations with typed diagnostics on the vars line', () => {
    const parsed = parse([
      '---',
      `grammar: ${GRAMMAR_VERSION}`,
      'name: Intake',
      'trigger: hi',
      'vars: tracking_id:text, tracking_id:number',
      '---',
      'Ask for it.',
    ].join('\n'), { resolveSkill: () => false })

    expect(parsed).toEqual({
      ok: false,
      diagnostics: [{
        line: 5,
        code: 'duplicate_var_declaration',
        message: 'Duplicate vars declaration for "tracking_id"',
      }],
    })
  })

  it('rejects recognized bracket tokens whose bodies fail their grammar', () => {
    const parsed = parse([
      '---',
      `grammar: ${GRAMMAR_VERSION}`,
      'name: Branch',
      'trigger: hi',
      '---',
      '[if status ~~ paid] -> end',
      '[filled ] -> end',
      '[action ]',
      '[decision route: yes]',
      '[approval route: yes="Yes"]',
      '[if amount >=] -> end',
      '[if country in ] -> end',
      '[if order_date older than 30] -> end',
    ].join('\n'), { resolveSkill: () => false })

    expect(parsed).toEqual({
      ok: false,
      diagnostics: [
        {
          line: 6,
          code: 'invalid_guard_token',
          message: 'Invalid guard token: [if status ~~ paid]',
        },
        {
          line: 7,
          code: 'invalid_guard_token',
          message: 'Invalid guard token: [filled ]',
        },
        {
          line: 8,
          code: 'invalid_action_token',
          message: 'Invalid action token: [action ]',
        },
        {
          line: 9,
          code: 'invalid_gate_token',
          message: 'Invalid gate token: [decision route: yes]',
        },
        {
          line: 10,
          code: 'invalid_gate_token',
          message: 'Invalid gate token: [approval route: yes="Yes"]',
        },
        {
          line: 11,
          code: 'invalid_guard_token',
          message: 'Invalid guard token: [if amount >=]',
        },
        {
          line: 12,
          code: 'invalid_guard_token',
          message: 'Invalid guard token: [if country in ]',
        },
        {
          line: 13,
          code: 'invalid_guard_token',
          message: 'Invalid guard token: [if order_date older than 30]',
        },
      ],
    })
  })

  it('accepts operandless presence guards and complete relative-date guards', () => {
    const parsed = parse([
      '---',
      `grammar: ${GRAMMAR_VERSION}`,
      'name: Branch',
      'trigger: hi',
      '---',
      '[if email is present] -> end',
      '[if order_date older than 30 days] -> end',
    ].join('\n'), { resolveSkill: () => false })

    expect(parsed).toMatchObject({
      ok: true,
      doc: {
        paragraphs: [
          {
            segments: [
              { kind: 'chip', chipKind: 'condition', refId: 'email', op: 'is_present' },
              { kind: 'chip', chipKind: 'end', refId: 'done' },
            ],
          },
          {
            segments: [
              { kind: 'chip', chipKind: 'condition', refId: 'order_date', op: 'older_than', value: 30, unit: 'days' },
              { kind: 'chip', chipKind: 'end', refId: 'done' },
            ],
          },
        ],
      },
    })
  })

  it('rejects invalid skill binding suffixes instead of parsing them as prose', () => {
    const parsed = parse([
      '---',
      `grammar: ${GRAMMAR_VERSION}`,
      'name: Skill',
      'trigger: hi',
      '---',
      '#lookup[in email]',
    ].join('\n'), { resolveSkill: () => true })

    expect(parsed).toEqual({
      ok: false,
      diagnostics: [{
        line: 6,
        code: 'invalid_skill_binding_suffix',
        message: 'Invalid skill binding suffix for "#lookup": [in email]',
      }],
    })
  })

  it('rejects branch lines that combine a guard token with a counter suffix', () => {
    const parsed = parse([
      '---',
      `grammar: ${GRAMMAR_VERSION}`,
      'name: Loop',
      'trigger: hi',
      '---',
      '[if amount >= 100] -> step:earlier_step (max 2)',
    ].join('\n'), { resolveSkill: () => false })

    expect(parsed).toEqual({
      ok: false,
      diagnostics: [{
        line: 6,
        code: 'conflicting_guard_and_counter',
        message: 'Branch line combines a guard token with a counter limit; use "-> step:earlier_step (max 2)" without another guard for a bounded loop',
      }],
    })
  })

  it('parses missing grammar version as v1', () => {
    const parsed = parse('---\nname: Greeter\ntrigger: hi\n---\nAsk @email.', { resolveSkill: () => false })

    expect(parsed).toMatchObject({ ok: true, grammarVersion: 1 })
  })

  it('rejects unsupported grammar versions with a typed diagnostic', () => {
    const parsed = parse('---\ngrammar: 99\nname: Greeter\ntrigger: hi\n---\nAsk @email.', { resolveSkill: () => false })

    expect(parsed).toEqual({
      ok: false,
      diagnostics: [{
        line: 2,
        code: 'unsupported_grammar_version',
        message: 'Unsupported routine grammar version: 99',
      }],
    })
  })

  it('round-trips contextVariableRef binding tokens', () => {
    const input = {
      name: 'order',
      trigger: 'order support',
      variables: [{ id: 'email', name: 'email', type: 'email' as const }],
      paragraphs: [
        { segments: [
          {
            kind: 'chip' as const,
            chipKind: 'skill' as const,
            refId: 'order_lookup',
            label: 'order_lookup',
            inputBindings: {
              email: { kind: 'variableRef' as const, ref: 'email' },
              region: { kind: 'contextVariableRef' as const, contextVariable: 'page_locale' },
            },
          },
        ] },
      ],
    }

    const { text, parsed } = roundTrip(input, ['order_lookup'])

    expect(text).toContain('#order_lookup[in email=@email, region=ctx.page_locale]')
    expect(chipShape(parsed.paragraphs)).toEqual(chipShape(input.paragraphs))
  })

  it('canonicalize is idempotent', () => {
    const first = canonicalize('---\nname: Greeter\ntrigger: hi\n---\nAsk @email.', { resolveSkill: () => false })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = canonicalize(first.content, { resolveSkill: () => false })

    expect(second).toEqual(first)
  })

  it('round-trips the screenshot routine: headings, variables, end and handoff', () => {
    const input = {
      name: 'Greeter',
      trigger: 'When the user says "thanks, cap"',
      variables: [{ id: 'name', name: 'name', type: 'text' as const }],
      paragraphs: [
        { headingLevel: 1 as const, segments: [{ kind: 'text' as const, text: 'Step 1. Acknowledgement' }] },
        {
          segments: [
            { kind: 'text' as const, text: 'Ask the person for their name and record as ' },
            { kind: 'chip' as const, chipKind: 'variable' as const, refId: 'name', label: '@name' },
            { kind: 'text' as const, text: '.' },
          ],
        },
        { headingLevel: 1 as const, segments: [{ kind: 'text' as const, text: 'Step 3. Search' }] },
        {
          segments: [
            { kind: 'text' as const, text: 'If there is context, answer and end. ' },
            { kind: 'chip' as const, chipKind: 'end' as const, refId: 'done', label: 'end' },
          ],
        },
        {
          segments: [
            { kind: 'text' as const, text: 'If no context, someone will be in touch soon and ' },
            { kind: 'chip' as const, chipKind: 'handoff' as const, refId: 'handoff', label: 'handoff' },
          ],
        },
      ],
    }
    const { text, parsed } = roundTrip(input)

    expect(text).toContain('name: Greeter')
    expect(text).toContain('# Step 1. Acknowledgement')
    expect(text).toContain('record as @name.')
    expect(text).toContain('end. -> end')
    expect(text).toContain('soon and -> handoff')

    expect(parsed.name).toBe('Greeter')
    expect(parsed.trigger).toBe('When the user says "thanks, cap"')
    expect(parsed.variables).toEqual([{ id: 'name', name: 'name', type: 'text' }])
    expect(chipShape(parsed.paragraphs)).toEqual(chipShape(input.paragraphs))
  })

  it('round-trips field-guard conditions across operator shapes', () => {
    const input = {
      name: 'eligibility',
      trigger: 'when checking eligibility',
      variables: [
        { id: 'amount', name: 'amount', type: 'number' as const },
        { id: 'tier', name: 'tier', type: 'text' as const },
        { id: 'signup', name: 'signup', type: 'date' as const },
        { id: 'vip', name: 'vip', type: 'boolean' as const },
      ],
      paragraphs: [
        { segments: [
          { kind: 'chip' as const, chipKind: 'condition' as const, refId: 'amount', op: 'gte' as const, value: 100, label: 'amount >= 100' },
          { kind: 'chip' as const, chipKind: 'end' as const, refId: 'done', label: 'end' },
        ] },
        { segments: [
          { kind: 'chip' as const, chipKind: 'condition' as const, refId: 'tier', op: 'in' as const, values: ['gold', 'platinum'], label: 'tier in gold, platinum' },
          { kind: 'chip' as const, chipKind: 'end' as const, refId: 'done', label: 'end' },
        ] },
        { segments: [
          { kind: 'chip' as const, chipKind: 'condition' as const, refId: 'signup', op: 'older_than' as const, value: 6, unit: 'months' as const, label: 'signup older than 6 months' },
          { kind: 'chip' as const, chipKind: 'handoff' as const, refId: 'handoff', label: 'handoff' },
        ] },
        { segments: [
          { kind: 'chip' as const, chipKind: 'condition' as const, refId: 'vip', op: 'is_true' as const, label: 'vip is true' },
          { kind: 'chip' as const, chipKind: 'end' as const, refId: 'done', label: 'end' },
        ] },
      ],
    }
    const { text, parsed } = roundTrip(input)

    expect(text).toContain('vars: amount:number, signup:date, vip:boolean')
    expect(text).toContain('[if amount >= 100]')
    expect(text).toContain('[if tier in gold, platinum]')
    expect(text).toContain('[if signup older than 6 months]')
    expect(text).toContain('[if vip is true]')

    expect(chipShape(parsed.paragraphs)).toEqual(chipShape(input.paragraphs))
    expect(parsed.variables).toContainEqual({ id: 'amount', name: 'amount', type: 'number' })
    expect(parsed.variables).toContainEqual({ id: 'signup', name: 'signup', type: 'date' })
    expect(parsed.variables).toContainEqual({ id: 'vip', name: 'vip', type: 'boolean' })
  })

  it('round-trips optional and mutable slot flags through the vars declaration', () => {
    const input = {
      name: 'intake',
      trigger: 'when collecting details',
      variables: [
        { id: 'email', name: 'email', type: 'email' as const, required: false },
        { id: 'note', name: 'note', type: 'text' as const, mutable: true },
        { id: 'phone', name: 'phone', type: 'text' as const, required: false, mutable: true },
        { id: 'name', name: 'name', type: 'text' as const },
      ],
      paragraphs: [
        { segments: [
          { kind: 'text' as const, text: 'Collect ' },
          { kind: 'chip' as const, chipKind: 'variable' as const, refId: 'email', label: '@email' },
          { kind: 'text' as const, text: ', ' },
          { kind: 'chip' as const, chipKind: 'variable' as const, refId: 'note', label: '@note' },
          { kind: 'text' as const, text: ', ' },
          { kind: 'chip' as const, chipKind: 'variable' as const, refId: 'phone', label: '@phone' },
          { kind: 'text' as const, text: ', ' },
          { kind: 'chip' as const, chipKind: 'variable' as const, refId: 'name', label: '@name' },
          { kind: 'text' as const, text: '.' },
        ] },
      ],
    }
    const { text, parsed } = roundTrip(input)

    expect(text).toContain('email:email:optional')
    expect(text).toContain('note:text:mutable')
    expect(text).toContain('phone:text:optional:mutable')

    expect(parsed.variables).toContainEqual({ id: 'email', name: 'email', type: 'email', required: false })
    expect(parsed.variables).toContainEqual({ id: 'note', name: 'note', type: 'text', mutable: true })
    expect(parsed.variables).toContainEqual({ id: 'phone', name: 'phone', type: 'text', required: false, mutable: true })
    // A required, non-mutable text variable round-trips bare — no flags, no declaration needed.
    expect(parsed.variables).toContainEqual({ id: 'name', name: 'name', type: 'text' })
  })

  it('round-trips a declared but unreferenced variable through vars', () => {
    const source = [
      '---',
      `grammar: ${GRAMMAR_VERSION}`,
      'name: Intake',
      'trigger: when collecting details',
      'vars: email:email:optional:mutable, internal_note:text',
      '---',
      'Ask for the order number.',
    ].join('\n')

    const parsed = parseProseDoc(source, () => false)
    const serialized = serializeProseDoc({
      name: parsed.name ?? '',
      trigger: parsed.trigger ?? '',
      variables: parsed.variables,
      paragraphs: parsed.paragraphs,
    })
    const reparsed = parseProseDoc(serialized, () => false)

    expect(parsed.variables).toEqual([
      { id: 'email', name: 'email', type: 'email', required: false, mutable: true },
      { id: 'internal_note', name: 'internal_note', type: 'text' },
    ])
    expect(draftFromChipDoc({
      name: parsed.name ?? '',
      trigger: parsed.trigger ?? '',
      variables: parsed.variables,
      blocks: parsed.paragraphs.map((paragraph) => ({
        text: paragraph.segments.map((segment) => segment.kind === 'text' ? segment.text : '').join(''),
        chips: [],
      })),
    }).slots).toEqual([
      expect.objectContaining({ key: 'email', type: 'email', required: false, mutable: true, ordinal: 0 }),
      expect.objectContaining({ key: 'internal_note', type: 'text', required: true, ordinal: 1 }),
    ])
    expect(serialized).toContain('vars: email:email:optional:mutable, internal_note:text')
    expect(reparsed.variables).toEqual(parsed.variables)
  })

  it('canonicalizes branch targets with one space before the arrow', () => {
    const result = canonicalize([
      '---',
      `grammar: ${GRAMMAR_VERSION}`,
      'name: Branches',
      'trigger: when branching',
      'vars: email:email',
      '---',
      '[filled @email]-> end',
      '[outcome failed]-> handoff',
    ].join('\n'))

    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error('expected canonicalize to succeed')
    expect(result.content).toContain('[filled @email] -> end')
    expect(result.content).toContain('[outcome failed] -> handoff')
  })

  it('round-trips a capped backward jump', () => {
    const input = {
      name: 'retry',
      trigger: 'retry flow',
      variables: [],
      paragraphs: [
        { headingLevel: 1 as const, segments: [{ kind: 'text' as const, text: 'Lookup' }] },
        { segments: [
          { kind: 'text' as const, text: 'Try again. ' },
          { kind: 'chip' as const, chipKind: 'step' as const, refId: 'lookup', label: 'Lookup', counterLimit: 2 },
        ] },
      ],
    }
    const { text, parsed } = roundTrip(input)
    expect(text).toContain('-> step:lookup (max 2)')
    expect(chipShape(parsed.paragraphs)).toEqual(chipShape(input.paragraphs))
  })

  it('round-trips a skill chip with typed input/output bindings', () => {
    const input = {
      name: 'order',
      trigger: 'order support',
      variables: [{ id: 'email', name: 'email', type: 'email' as const }],
      paragraphs: [
        { segments: [
          { kind: 'text' as const, text: 'Look it up. ' },
          {
            kind: 'chip' as const,
            chipKind: 'skill' as const,
            refId: 'order_lookup',
            label: 'order_lookup',
            inputBindings: { email: { kind: 'variableRef' as const, ref: 'email' }, includeHistory: { kind: 'literal' as const, value: true } },
            outputAssignments: { status: 'order_status' },
            mode: 'typed' as const,
          },
        ] },
      ],
    }
    const { text, parsed } = roundTrip(input, ['order_lookup'])
    // A skill mention uses `#`; the bindings still reference `@` variables.
    expect(text).toContain('#order_lookup[in email=@email, includeHistory=true; out status=@order_status]')
    expect(chipShape(parsed.paragraphs)).toEqual(chipShape(input.paragraphs))
  })

  it('keeps an unbound skill a clean mention and resolves it via the catalog', () => {
    const input = {
      name: 'search',
      trigger: 'search',
      variables: [],
      paragraphs: [
        { headingLevel: 1 as const, segments: [{ kind: 'text' as const, text: 'Search' }] },
        { segments: [{ kind: 'chip' as const, chipKind: 'skill' as const, refId: 'retrieval_context', label: 'retrieval_context' }] },
      ],
    }
    const { text, parsed } = roundTrip(input, ['retrieval_context'])
    expect(text).toContain('#retrieval_context')
    expect(text).not.toContain('[')
    expect(parsed.paragraphs[1]!.segments[0]).toMatchObject({ kind: 'chip', chipKind: 'skill', refId: 'retrieval_context' })
  })

  it('parses a #mention as a skill without needing the catalog', () => {
    const parsed = parseProseDoc('Run #retrieval_context now.', () => false)
    expect(parsed.paragraphs[0]!.segments).toEqual([
      { kind: 'text', text: 'Run ' },
      { kind: 'chip', chipKind: 'skill', refId: 'retrieval_context', label: 'retrieval_context' },
      { kind: 'text', text: ' now.' },
    ])
  })

  it('still parses a legacy @mention skill via the catalog (back-compat)', () => {
    const parsed = parseProseDoc('Run @retrieval_context now.', (name) => name === 'retrieval_context')
    expect(parsed.paragraphs[0]!.segments[1]).toMatchObject({ kind: 'chip', chipKind: 'skill', refId: 'retrieval_context' })
  })

  it('treats an unknown @mention as a variable when it is not a known skill', () => {
    const parsed = parseProseDoc('Hello @customer_name.', () => false)
    expect(parsed.paragraphs[0]!.segments).toEqual([
      { kind: 'text', text: 'Hello ' },
      { kind: 'chip', chipKind: 'variable', refId: 'customer_name', label: '@customer_name' },
      { kind: 'text', text: '.' },
    ])
    expect(parsed.variables).toEqual([{ id: 'customer_name', name: 'customer_name', type: 'text' }])
  })

  it('detects routine prose vs ordinary text', () => {
    expect(looksLikeRoutineProse('---\nname: x\ntrigger: y\n---\nHi.')).toBe(true)
    expect(looksLikeRoutineProse('Ask for @email then continue.')).toBe(true)
    expect(looksLikeRoutineProse('Finish and -> handoff')).toBe(true)
    expect(looksLikeRoutineProse('Just some pasted sentence with no tokens.')).toBe(false)
  })

  // The paste handler replaces the whole document only when `hadFrontmatter` is set, so a
  // foreign doc that merely opens with `---` is inserted, not destructive.
  it('reports hadFrontmatter only for our fenced routine frontmatter', () => {
    expect(parseProseDoc('---\nname: Greeter\ntrigger: hi\n---\nAsk @x.', () => false).hadFrontmatter).toBe(true)
    expect(parseProseDoc('---\nvars: amount:number\n---\nCheck @amount.', () => false).hadFrontmatter).toBe(true)
    // A markdown doc with unrelated frontmatter and an @mention still parses (it looks like
    // prose) but must NOT be treated as a whole-routine replace.
    expect(parseProseDoc('---\ntitle: Notes\ntags: x\n---\nPing @world about it.', () => false).hadFrontmatter).toBe(false)
    // A bare fragment with a token but no fence is an insert, never a replace.
    expect(parseProseDoc('Ask for @email then -> handoff', () => false).hadFrontmatter).toBe(false)
  })

  it('round-trips an outcome guard and an action step as text tokens', () => {
    const input = {
      name: 'Escalate',
      trigger: 'wants a human',
      variables: [],
      paragraphs: [
        { segments: [
          { kind: 'text' as const, text: 'Email the team ' },
          { kind: 'chip' as const, chipKind: 'action' as const, refId: 'contact.send', label: 'contact.send' },
        ] },
        { segments: [
          { kind: 'chip' as const, chipKind: 'condition' as const, refId: OUTCOME_GUARD_REF, value: 'failed', label: 'outcome is failed' },
          { kind: 'chip' as const, chipKind: 'handoff' as const, refId: 'handoff', label: 'handoff' },
        ] },
      ],
    }
    const { text, parsed } = roundTrip(input)
    expect(text).toContain('[action contact.send]')
    expect(text).toContain('[outcome failed]')
    // The action ref isn't mistaken for a variable.
    expect(parsed.variables).toEqual([])
    expect(chipShape(parsed.paragraphs)).toEqual(chipShape(input.paragraphs))
  })

  it('round-trips a slot-filled guard as a [filled] text token', () => {
    const input = {
      name: 'Verify',
      trigger: 'needs verification',
      variables: [
        { id: 'email', name: 'email', type: 'email' as const },
        { id: 'order_id', name: 'order id', type: 'text' as const },
      ],
      paragraphs: [
        { segments: [
          { kind: 'text' as const, text: 'Ask for ' },
          { kind: 'chip' as const, chipKind: 'variable' as const, refId: 'email', label: '@email' },
          { kind: 'text' as const, text: ' and ' },
          { kind: 'chip' as const, chipKind: 'variable' as const, refId: 'order_id', label: '@order_id' },
          { kind: 'text' as const, text: '.' },
        ] },
        { segments: [
          { kind: 'chip' as const, chipKind: 'condition' as const, refId: SLOT_FILLED_GUARD_REF, values: ['email', 'order_id'], label: 'when email and order id are provided' },
          { kind: 'chip' as const, chipKind: 'handoff' as const, refId: 'handoff', label: 'handoff' },
        ] },
      ],
    }
    const { text, parsed } = roundTrip(input)
    expect(text).toContain('[filled @email, @order_id]')
    const filled = parsed.paragraphs.flatMap((paragraph) => paragraph.segments)
      .find((segment) => segment.kind === 'chip' && segment.refId === SLOT_FILLED_GUARD_REF)
    expect(filled).toMatchObject({ chipKind: 'condition', values: ['email', 'order_id'] })
  })

  it('round-trips a named ending with its message as a -> end:id token', () => {
    const input = {
      name: 'Refund',
      trigger: 'wants a refund',
      variables: [],
      paragraphs: [
        { segments: [{ kind: 'text' as const, text: 'Check eligibility.' }] },
        { segments: [
          { kind: 'chip' as const, chipKind: 'condition' as const, refId: '', label: '' },
          { kind: 'text' as const, text: 'If not eligible' },
          { kind: 'chip' as const, chipKind: 'end' as const, refId: 'ineligible', label: 'ineligible', value: 'Sorry, not eligible.' },
        ] },
        { segments: [{ kind: 'text' as const, text: 'Refund and finish.' }] },
      ],
    }
    const { text, parsed } = roundTrip(input)
    expect(text).toContain('-> end:ineligible ("Sorry, not eligible.")')
    const endChip = parsed.paragraphs.flatMap((paragraph) => paragraph.segments)
      .find((segment) => segment.kind === 'chip' && segment.chipKind === 'end' && segment.refId === 'ineligible')
    expect(endChip).toMatchObject({ refId: 'ineligible', value: 'Sorry, not eligible.' })
  })

  it('round-trips stable ids with dashes and dots in route target tokens', () => {
    const input = {
      name: 'Eligibility',
      trigger: 'needs routing',
      variables: [],
      paragraphs: [
        { segments: [
          { kind: 'chip' as const, chipKind: 'end' as const, refId: 'ineligible-case', label: 'ineligible-case' },
        ] },
        { segments: [
          { kind: 'chip' as const, chipKind: 'step' as const, refId: 'v2.flow-check', label: 'v2.flow-check', counterLimit: 3 },
        ] },
      ],
    }

    const { text, parsed } = roundTrip(input)

    expect(text).toContain('-> end:ineligible-case')
    expect(text).toContain('-> step:v2.flow-check (max 3)')
    expect(chipShape(parsed.paragraphs)).toEqual(chipShape(input.paragraphs))
  })

  it('rejects route target tokens followed by illegal id delimiters', () => {
    const parsed = parse('---\ngrammar: 1\nname: Bad target\ntrigger: route\n---\n-> step:review/order\n', { resolveSkill: () => false })

    expect(parsed).toEqual({
      ok: false,
      diagnostics: [{
        line: 6,
        code: 'invalid_target_token',
        message: 'Invalid target token: -> step:review/order',
      }],
    })
  })

  it('quotes action types that do not fit the bare token grammar', () => {
    const input = {
      name: 'Escalate',
      trigger: 'notify a downstream system',
      variables: [],
      paragraphs: [
        { segments: [
          { kind: 'text' as const, text: 'Notify ops ' },
          { kind: 'chip' as const, chipKind: 'action' as const, refId: 'ops/send:urgent 2', label: 'ops/send:urgent 2' },
        ] },
      ],
    }
    const { text, parsed } = roundTrip(input)

    expect(text).toContain('[action "ops/send:urgent 2"]')
    expect(chipShape(parsed.paragraphs)).toEqual(chipShape(input.paragraphs))
  })

  it('round-trips a decision gate declaration (capture key + choices) as a text token', () => {
    const input = {
      name: 'Refund approval',
      trigger: 'wants a large refund',
      variables: [],
      paragraphs: [
        { segments: [
          { kind: 'text' as const, text: 'Get a manager decision. ' },
          { kind: 'chip' as const, chipKind: 'decision' as const, refId: 'refund_decision', captureKey: 'refund_decision', label: 'decision', options: [
            { id: 'approve', label: 'Approve' },
            { id: 'deny', label: 'Deny', description: 'Decline the refund' },
          ] },
        ] },
      ],
    }
    const { text, parsed } = roundTrip(input)
    expect(text).toContain('[decision refund_decision: approve="Approve", deny="Deny" ("Decline the refund")]')
    // The capture key is not collected as a variable.
    expect(parsed.variables).toEqual([])
    const decision = parsed.paragraphs.flatMap((p) => p.segments).find((s) => s.kind === 'chip' && s.chipKind === 'decision')
    expect(decision).toMatchObject({
      chipKind: 'decision',
      captureKey: 'refund_decision',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'deny', label: 'Deny', description: 'Decline the refund' },
      ],
    })
  })

  it('escapes quotes and brackets in decision labels and descriptions', () => {
    const input = {
      name: 'Refund approval',
      trigger: 'wants a large refund',
      variables: [],
      paragraphs: [
        { segments: [
          { kind: 'chip' as const, chipKind: 'decision' as const, refId: 'refund_decision', captureKey: 'refund_decision', label: 'decision', options: [
            { id: 'approve', label: 'Manager says "yes"', description: 'Use the [fast] path\\now' },
            { id: 'deny', label: 'Deny' },
          ] },
        ] },
      ],
    }
    const { text, parsed } = roundTrip(input)

    expect(text).toContain('approve="Manager says \\"yes\\""')
    expect(text).toContain('("Use the [fast] path\\\\now")')
    const decision = parsed.paragraphs.flatMap((p) => p.segments).find((s) => s.kind === 'chip' && s.chipKind === 'decision')
    expect(decision).toMatchObject({
      options: [
        { id: 'approve', label: 'Manager says "yes"', description: 'Use the [fast] path\\now' },
        { id: 'deny', label: 'Deny' },
      ],
    })
  })

  it('round-trips an approval gate (choices with routing targets) as a text token', () => {
    const input = {
      name: 'Refund approval',
      trigger: 'wants a large refund',
      variables: [],
      paragraphs: [
        { segments: [
          { kind: 'chip' as const, chipKind: 'approval' as const, refId: 'refund_decision', captureKey: 'refund_decision', label: 'approval', options: [
            { id: 'approve', label: 'Approve', target: 'done' },
            { id: 'deny', label: 'Deny', target: 'handoff' },
          ] },
        ] },
      ],
    }
    const { text, parsed } = roundTrip(input)
    expect(text).toContain('[approval refund_decision: approve="Approve" -> end, deny="Deny" -> handoff]')
    const approval = parsed.paragraphs.flatMap((p) => p.segments).find((s) => s.kind === 'chip' && s.chipKind === 'approval')
    expect(approval).toMatchObject({
      chipKind: 'approval',
      captureKey: 'refund_decision',
      options: [
        { id: 'approve', label: 'Approve', target: 'done' },
        { id: 'deny', label: 'Deny', target: 'handoff' },
      ],
    })
  })

  it('round-trips approval option ids and targets with stable-id punctuation', () => {
    const input = {
      name: 'Refund approval',
      trigger: 'wants a large refund',
      variables: [],
      paragraphs: [
        { segments: [
          { kind: 'chip' as const, chipKind: 'approval' as const, refId: 'refund_decision', captureKey: 'refund_decision', label: 'approval', options: [
            { id: 'approve-fast', label: 'Approve', target: 'v2.flow-check' },
            { id: 'deny.case', label: 'Deny', target: 'handoff' },
          ] },
        ] },
      ],
    }

    const { text, parsed } = roundTrip(input)

    expect(text).toContain('[approval refund_decision: approve-fast="Approve" -> step:v2.flow-check, deny.case="Deny" -> handoff]')
    const approval = parsed.paragraphs.flatMap((p) => p.segments).find((s) => s.kind === 'chip' && s.chipKind === 'approval')
    expect(approval).toMatchObject({
      options: [
        { id: 'approve-fast', label: 'Approve', target: 'v2.flow-check' },
        { id: 'deny.case', label: 'Deny', target: 'handoff' },
      ],
    })
  })
})
