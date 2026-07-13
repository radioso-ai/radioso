import { describe, expect, it } from 'vitest'

import {
  GRAMMAR_VERSION,
  canonicalize,
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
})
