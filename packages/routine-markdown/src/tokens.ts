// Canonical plain-text grammar for a routine's prose, so the chip editor can copy to an
// external file and paste back without losing structure. The Lexical chip nodes already
// round-trip in-app via their JSON clipboard flavour; this grammar is what survives the
// text/plain (and text/html) flavours an external app like Notes keeps — every chip
// becomes a readable token, and parsing the tokens rebuilds the chips.
//
// The token spellings deliberately mirror the backend routine-document grammar
// (`backend/.../routines/document`) so the two surfaces stay one grammar: `@ref` mentions,
// `-> #step` / end targets, and bracketed guards. Keep them in sync when either moves.

import type {
  ApprovalDocOption,
  ChipDocVariable,
  ParseDiagnostic,
  ProseChipKind,
  ProseParagraph,
  ProseSegment,
  RoutineInputBinding,
  RoutineFieldGuardOp,
  RoutineFieldGuardUnit,
  RoutineCompletionExport,
  RoutineSlotType,
  RoutineStepMode,
} from './types.js'
import { OUTCOME_GUARD_REF, SLOT_FILLED_GUARD_REF } from './types.js'
import type { RoutineReentryMode } from '@radioso/routine-definition'

export type RoutineFieldGuardValue = string | number | boolean

export type ParsedProseDoc = {
  name: string | null
  trigger: string | null
  reentryMode: RoutineReentryMode
  priority: number
  completionExport?: RoutineCompletionExport
  variables: ChipDocVariable[]
  paragraphs: ProseParagraph[]
  // True only when the text opened with our fenced frontmatter carrying a recognized
  // routine key (name/trigger/vars). This is the signal that the paste is a whole routine
  // and may replace the document — a bare leading `---` (e.g. a markdown doc) is not.
  hadFrontmatter: boolean
}

export type ParseSuccess = {
  ok: true
  grammarVersion: typeof GRAMMAR_VERSION
  doc: ParsedProseDoc
}

export type ParseFailure = {
  ok: false
  diagnostics: ParseDiagnostic[]
}

export type ParseResult = ParseSuccess | ParseFailure

export type CanonicalizeResult =
  | { ok: true; grammarVersion: typeof GRAMMAR_VERSION; content: string }
  | ParseFailure

export const GRAMMAR_VERSION = 1
const FRONTMATTER_KEYS = new Set(['grammar', 'name', 'trigger', 'vars', 'reentry', 'priority', 'export'])
const EXPORT_TRIGGER_KINDS = new Set(['complete', 'handoff'])

// The chip fields the token serializer reads. Both a ProseSegment chip and a live
// ChipNode project onto this, so copy (node) and serialize (segment) share one encoder.
export type ChipTokenInput = {
  chipKind: ProseChipKind
  refId: string
  op?: RoutineFieldGuardOp | null
  value?: RoutineFieldGuardValue | null
  values?: RoutineFieldGuardValue[] | null
  unit?: RoutineFieldGuardUnit | null
  counterLimit?: number | null
  inputBindings?: Record<string, RoutineInputBinding>
  outputAssignments?: Record<string, string>
  mode?: RoutineStepMode | null
  // Approval / decision gates: the captured slot and the choices (each with an optional
  // description, and — for the block `approval` form — a routing target).
  captureKey?: string | null
  options?: ApprovalDocOption[]
}

// The frontmatter fence and the readable comparison operators. The operator tokens are
// matched longest-first on parse so `>=` wins over `>` and `is true` over `is`.
const FENCE = '---'
const SLOT_TYPES: readonly RoutineSlotType[] = ['text', 'number', 'boolean', 'email', 'date']
const GUARD_UNITS: readonly RoutineFieldGuardUnit[] = ['days', 'weeks', 'months', 'years']

const OP_TOKENS: Record<RoutineFieldGuardOp, string> = {
  is_true: 'is true',
  is_false: 'is false',
  is_present: 'is present',
  is_absent: 'is absent',
  equals: '=',
  not_equals: '!=',
  in: 'in',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  older_than: 'older than',
  within: 'within',
}

// Longest token first so multi-word / multi-char operators win the match.
const OP_ENTRIES: Array<[RoutineFieldGuardOp, string]> = (Object.entries(OP_TOKENS) as Array<[RoutineFieldGuardOp, string]>)
  .sort((left, right) => right[1].length - left[1].length)

const opNeedsValue = (op: RoutineFieldGuardOp): boolean =>
  op !== 'is_true' && op !== 'is_false' && op !== 'is_present' && op !== 'is_absent'

const opNeedsUnit = (op: RoutineFieldGuardOp): boolean => op === 'older_than' || op === 'within'

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

const formatLiteral = (value: RoutineFieldGuardValue): string =>
  typeof value === 'string' ? value : String(value)

const escapeQuoted = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

const unescapeQuoted = (value: string): string =>
  value.replace(/\\(.)/g, '$1')

const BARE_ACTION_REF = /^[A-Za-z_][A-Za-z0-9_.-]*$/

const formatBinding = (binding: RoutineInputBinding): string =>
  binding.kind === 'variableRef'
    ? `@${binding.ref}`
    : binding.kind === 'contextVariableRef'
      ? `ctx.${binding.contextVariable}`
      : formatLiteral(binding.value)

// A skill chip carries optional typed bindings (spec 090). They have no inline form in
// prose, so they ride in a bracket suffix that only appears when non-default — an unbound
// skill stays a clean `#skill_name`.
const formatSkillSuffix = (chip: ChipTokenInput): string => {
  const sections: string[] = []
  const inputs = Object.entries(chip.inputBindings ?? {})
  if (inputs.length > 0) {
    sections.push(`in ${inputs.map(([name, binding]) => `${name}=${formatBinding(binding)}`).join(', ')}`)
  }
  const outputs = Object.entries(chip.outputAssignments ?? {})
  if (outputs.length > 0) {
    sections.push(`out ${outputs.map(([name, ref]) => `${name}=@${ref}`).join(', ')}`)
  }
  if (chip.mode && chip.mode !== 'typed') {
    sections.push(`mode ${chip.mode}`)
  }
  return sections.length > 0 ? `[${sections.join('; ')}]` : ''
}

const formatConditionToken = (chip: ChipTokenInput): string => {
  // An outcome guard is a condition chip with the sentinel ref; its status rides in `value`.
  if (chip.refId === OUTCOME_GUARD_REF) return `[outcome ${formatLiteral(chip.value ?? '')}]`
  // A slot-filled guard is a condition chip with the sentinel ref; its slot keys ride in `values`.
  if (chip.refId === SLOT_FILLED_GUARD_REF) return `[filled ${(chip.values ?? []).map((value) => `@${value}`).join(', ')}]`
  const op = chip.op
  // A bare AI⇄code selector (empty ref, no operator) is a marker only; the decided-by-AI phrase
  // rides in the adjacent prose text, so the chip itself contributes no token.
  if (!chip.refId && !op) return ''
  if (!op) return `[if ${chip.refId}]`
  const token = OP_TOKENS[op]
  if (!opNeedsValue(op)) return `[if ${chip.refId} ${token}]`
  if (op === 'in') return `[if ${chip.refId} in ${(chip.values ?? []).map(formatLiteral).join(', ')}]`
  if (opNeedsUnit(op)) return `[if ${chip.refId} ${token} ${formatLiteral(chip.value ?? '')} ${chip.unit ?? ''}]`.replace(/\s+/g, ' ').trimEnd()
  return `[if ${chip.refId} ${token} ${formatLiteral(chip.value ?? '')}]`
}

// A target an approval option routes to, in the same spelling branch lines use.
const formatTarget = (target: string): string =>
  target === 'done' ? 'end' : target === 'handoff' ? 'handoff' : `step:${target}`

// One choice of a gate: `id="Label"`, an optional `("Description")`, and — for the block
// approval form — an optional `-> target`. Quotes and backslashes are escaped so authored
// labels/descriptions survive portable text copy/paste.
const formatOption = (option: ApprovalDocOption, includeTarget: boolean): string => {
  let token = `${option.id}="${escapeQuoted(option.label)}"`
  if (option.description) token += ` ("${escapeQuoted(option.description)}")`
  if (includeTarget && option.target) token += ` -> ${formatTarget(option.target)}`
  return token
}

const formatGateToken = (keyword: 'decision' | 'approval', chip: ChipTokenInput): string => {
  const captureKey = chip.captureKey ?? chip.refId
  const options = (chip.options ?? []).map((option) => formatOption(option, keyword === 'approval')).join(', ')
  return `[${keyword} ${captureKey}: ${options}]`
}

const formatActionToken = (refId: string): string =>
  BARE_ACTION_REF.test(refId) ? `[action ${refId}]` : `[action "${escapeQuoted(refId)}"]`

// One chip → its canonical inline token. Shared by the editor's copy path (live node) and
// document serialization (parsed segment).
export const tokenForChip = (chip: ChipTokenInput): string => {
  switch (chip.chipKind) {
    case 'variable':
      return `@${chip.refId}`
    case 'skill':
      // Skills use `#` (a capability) to stay distinct from `@` variables (a value).
      return `#${chip.refId}${formatSkillSuffix(chip)}`
    case 'end':
      // The default ending is `-> end`; a named ending carries its id and (optional) message.
      return chip.refId && chip.refId !== 'done'
        ? `-> end:${chip.refId}${typeof chip.value === 'string' && chip.value ? ` ("${escapeQuoted(chip.value)}")` : ''}`
        : '-> end'
    case 'handoff':
      return '-> handoff'
    case 'step':
      return `-> step:${chip.refId}${chip.counterLimit != null ? ` (max ${chip.counterLimit})` : ''}`
    case 'condition':
      return formatConditionToken(chip)
    case 'action':
      return formatActionToken(chip.refId)
    case 'decision':
      return formatGateToken('decision', chip)
    case 'approval':
      return formatGateToken('approval', chip)
    default:
      return ''
  }
}

const formatParagraph = (paragraph: ProseParagraph): string => {
  let body = ''
  for (const segment of paragraph.segments) {
    const token = segment.kind === 'text' ? segment.text : tokenForChip(segment)
    if (token.startsWith('->') && body !== '' && !/\s$/.test(body)) {
      body += ' '
    }
    body += token
  }
  return paragraph.headingLevel === 1 ? `# ${body}` : body
}

const referencedVariableIds = (paragraphs: ProseParagraph[]): Set<string> => {
  // A gate's capture key isn't a variable, and neither is the branch condition that tests it
  // (its refId is the capture key) nor the outcome sentinel — exclude all of those.
  const captureKeys = new Set<string>()
  for (const paragraph of paragraphs) {
    for (const segment of paragraph.segments) {
      if (segment.kind === 'chip' && (segment.chipKind === 'decision' || segment.chipKind === 'approval')) {
        captureKeys.add(segment.captureKey ?? segment.refId)
      }
    }
  }
  const ids = new Set<string>()
  for (const paragraph of paragraphs) {
    for (const segment of paragraph.segments) {
      if (segment.kind !== 'chip') continue
      if (segment.chipKind === 'variable') ids.add(segment.refId)
      // A slot-filled guard's refId is the sentinel (not a variable), but its `values` name real
      // slots — count those so they survive in the frontmatter even if nothing else references them.
      if (segment.chipKind === 'condition' && segment.refId === SLOT_FILLED_GUARD_REF) {
        for (const value of segment.values ?? []) if (typeof value === 'string') ids.add(value)
      } else if (segment.chipKind === 'condition' && segment.refId !== OUTCOME_GUARD_REF && !captureKeys.has(segment.refId)) {
        ids.add(segment.refId)
      }
      if (segment.chipKind === 'skill') {
        for (const binding of Object.values(segment.inputBindings ?? {})) {
          if (binding.kind === 'variableRef') ids.add(binding.ref)
        }
        for (const ref of Object.values(segment.outputAssignments ?? {})) ids.add(ref)
      }
    }
  }
  return ids
}

export const serializeProseDoc = (input: {
  name: string
  trigger: string
  reentryMode?: RoutineReentryMode
  priority?: number
  completionExport?: RoutineCompletionExport | null
  variables: ChipDocVariable[]
  paragraphs: ProseParagraph[]
}): string => {
  const referenced = referencedVariableIds(input.paragraphs)
  // A variable needs a declaration when it carries something a bare `@name` can't, or when
  // it is not referenced in the body. Unreferenced variables must stay in frontmatter or they
  // disappear on the next parse.
  const declaredVars = input.variables.filter((variable) =>
    !referenced.has(variable.id)
    || variable.type !== 'text'
    || variable.required === false
    || variable.mutable === true)

  const front = [FENCE, `grammar: ${GRAMMAR_VERSION}`, `name: ${input.name}`, `trigger: ${input.trigger}`]
  if (input.reentryMode && input.reentryMode !== 'once_per_conversation') {
    front.push(`reentry: ${input.reentryMode}`)
  }
  if (input.priority != null && input.priority !== 0) {
    front.push(`priority: ${input.priority}`)
  }
  if (input.completionExport?.enabled) {
    front.push(`export: ${input.completionExport.triggerKinds.join(',')} -> ${input.completionExport.destinationRef}`)
  }
  if (declaredVars.length > 0) {
    // Each declaration is `key:type` plus optional `:optional` / `:mutable` flag tokens.
    front.push(`vars: ${declaredVars.map((variable) => {
      const flags = [
        ...(variable.required === false ? ['optional'] : []),
        ...(variable.mutable === true ? ['mutable'] : []),
      ]
      return [variable.id, variable.type, ...flags].join(':')
    }).join(', ')}`)
  }
  front.push(FENCE)

  return `${[...front, ...input.paragraphs.map(formatParagraph)].join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]*/

const coerceLiteral = (raw: string): RoutineFieldGuardValue => {
  const trimmed = raw.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed)
  return trimmed
}

const parseBinding = (raw: string): RoutineInputBinding => {
  const trimmed = raw.trim()
  if (trimmed.startsWith('@')) return { kind: 'variableRef', ref: trimmed.slice(1) }
  if (trimmed.startsWith('ctx.')) return { kind: 'contextVariableRef', contextVariable: trimmed.slice(4) }
  return { kind: 'literal', value: coerceLiteral(trimmed) }
}

const splitList = (raw: string): string[] =>
  raw.split(',').map((part) => part.trim()).filter((part) => part !== '')

const parseExport = (value: string): RoutineCompletionExport | null => {
  const match = /^([A-Za-z_,\s]+)\s*->\s*(\S+)$/.exec(value.trim())
  if (!match) return null
  const triggerKinds = splitList(match[1]!)
  if (triggerKinds.length === 0 || triggerKinds.some((kind) => !EXPORT_TRIGGER_KINDS.has(kind))) return null
  return {
    enabled: true,
    triggerKinds: triggerKinds as RoutineCompletionExport['triggerKinds'],
    destinationRef: match[2]!,
  }
}

const parseReentryMode = (value: string): RoutineReentryMode | null => {
  if (value === 'once') return 'once_per_conversation'
  if (value === 'once_per_conversation' || value === 'always' || value === 'semantic') return value
  return null
}

// Parse a `[if ref op value unit]` condition body (the text already stripped of brackets).
const parseConditionBody = (body: string): Extract<ProseSegment, { kind: 'chip' }> | null => {
  const idMatch = IDENTIFIER.exec(body.trim())
  if (!idMatch) return null
  const refId = idMatch[0]
  const rest = body.trim().slice(refId.length).trim()
  if (rest === '') {
    return { kind: 'chip', chipKind: 'condition', refId, label: refId }
  }
  const entry = OP_ENTRIES.find(([, token]) => rest === token || rest.startsWith(`${token} `))
  if (!entry) return null
  const [op, token] = entry
  const tail = rest.slice(token.length).trim()
  if (!opNeedsValue(op)) {
    return { kind: 'chip', chipKind: 'condition', refId, op, label: `${refId} ${token}` }
  }
  if (op === 'in') {
    return { kind: 'chip', chipKind: 'condition', refId, op, values: splitList(tail).map(coerceLiteral), label: `${refId} in ${tail}` }
  }
  if (opNeedsUnit(op)) {
    const parts = tail.split(/\s+/)
    const unit = parts.length > 1 && (GUARD_UNITS as readonly string[]).includes(parts[parts.length - 1]!)
      ? (parts.pop() as RoutineFieldGuardUnit)
      : null
    return { kind: 'chip', chipKind: 'condition', refId, op, value: coerceLiteral(parts.join(' ')), unit, label: `${refId} ${token} ${tail}` }
  }
  return { kind: 'chip', chipKind: 'condition', refId, op, value: coerceLiteral(tail), label: `${refId} ${token} ${tail}` }
}

// Map a target token (`end` / `handoff` / `step:<id>`) back to its stored ref.
const parseTarget = (token: string | undefined): string | undefined => {
  if (!token) return undefined
  if (token === 'end') return 'done'
  if (token === 'handoff') return 'handoff'
  return token.startsWith('step:') ? token.slice('step:'.length) : undefined
}

// Parse a gate's option list: `id="Label" ("Description") -> target, ...`. Description and
// target are optional; whitespace and the comma separators are tolerated.
const QUOTED_VALUE = '"((?:\\\\.|[^"\\\\])*)"'
const GATE_OPTION = new RegExp(`([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*${QUOTED_VALUE}(?:\\s*\\(${QUOTED_VALUE}\\))?(?:\\s*->\\s*(end|handoff|step:[A-Za-z_][A-Za-z0-9_.-]*))?`, 'g')
const parseGateOptions = (body: string): ApprovalDocOption[] => {
  const options: ApprovalDocOption[] = []
  for (const match of body.matchAll(GATE_OPTION)) {
    const target = parseTarget(match[4])
    options.push({
      id: match[1]!,
      label: unescapeQuoted(match[2] ?? ''),
      ...(match[3] ? { description: unescapeQuoted(match[3]) } : {}),
      ...(target ? { target } : {}),
    })
  }
  return options
}

const findBracketClose = (value: string): number => {
  let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quoted && char === '\\') {
      index += 1
      continue
    }
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && char === ']') return index
  }
  return -1
}

const parseActionBody = (body: string): string | null => {
  const trimmed = body.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unescapeQuoted(trimmed.slice(1, -1))
  }
  const idMatch = IDENTIFIER.exec(trimmed)
  return idMatch && idMatch[0] === trimmed ? idMatch[0] : null
}

// Parse a `[decision key: ...]` / `[approval key: ...]` gate body (brackets already stripped).
const parseGateBody = (chipKind: 'decision' | 'approval', body: string): Extract<ProseSegment, { kind: 'chip' }> | null => {
  const colon = body.indexOf(':')
  if (colon === -1) return null
  const captureKey = body.slice(0, colon).trim()
  if (!captureKey) return null
  return {
    kind: 'chip',
    chipKind,
    refId: captureKey,
    captureKey,
    label: chipKind,
    options: parseGateOptions(body.slice(colon + 1)),
  }
}

const parseSkillSuffix = (suffix: string): Pick<Extract<ProseSegment, { kind: 'chip' }>, 'inputBindings' | 'outputAssignments' | 'mode'> => {
  const inputBindings: Record<string, RoutineInputBinding> = {}
  const outputAssignments: Record<string, string> = {}
  let mode: RoutineStepMode | undefined
  for (const section of suffix.split(';')) {
    const trimmed = section.trim()
    if (trimmed.startsWith('in ')) {
      for (const pair of splitList(trimmed.slice(3))) {
        const eq = pair.indexOf('=')
        if (eq > 0) inputBindings[pair.slice(0, eq).trim()] = parseBinding(pair.slice(eq + 1))
      }
    } else if (trimmed.startsWith('out ')) {
      for (const pair of splitList(trimmed.slice(4))) {
        const eq = pair.indexOf('=')
        if (eq > 0) outputAssignments[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim().replace(/^@/, '')
      }
    } else if (trimmed.startsWith('mode ')) {
      const value = trimmed.slice(5).trim()
      if (value === 'typed' || value === 'untyped') mode = value
    }
  }
  return { inputBindings, outputAssignments, mode }
}

// Parse one line's inline tokens into ordered segments. `resolveKind` decides whether a
// bare `@name` is a skill (in the agent's catalog) or a variable.
const parseSegments = (line: string, resolveKind: (name: string) => ProseChipKind): ProseSegment[] => {
  const segments: ProseSegment[] = []
  let buffer = ''
  let index = 0
  const flush = () => {
    if (buffer) segments.push({ kind: 'text', text: buffer })
    buffer = ''
  }
  const flushBeforeTarget = () => {
    if (/^\s+$/.test(buffer)) {
      buffer = ''
      return
    }
    flush()
  }
  while (index < line.length) {
    const rest = line.slice(index)

    if (rest.startsWith('-> end')) {
      // `-> end` (default ending) or `-> end:<id> ("message")` (a named ending with its own copy).
      const named = /^-> end:([A-Za-z_][A-Za-z0-9_]*)(?:\s+\("((?:[^"\\]|\\.)*)"\))?/.exec(rest)
      if (named) {
        flushBeforeTarget()
        segments.push({ kind: 'chip', chipKind: 'end', refId: named[1]!, label: named[1]!, value: named[2] != null ? unescapeQuoted(named[2]) : null })
        index += named[0].length
        continue
      }
      flushBeforeTarget(); segments.push({ kind: 'chip', chipKind: 'end', refId: 'done', label: 'end' }); index += '-> end'.length; continue
    }
    if (rest.startsWith('-> handoff')) { flushBeforeTarget(); segments.push({ kind: 'chip', chipKind: 'handoff', refId: 'handoff', label: 'handoff' }); index += '-> handoff'.length; continue }

    const stepMatch = /^-> step:([A-Za-z_][A-Za-z0-9_.-]*)(?:\s*\(max (\d+)\))?/.exec(rest)
    if (stepMatch) {
      flushBeforeTarget()
      segments.push({ kind: 'chip', chipKind: 'step', refId: stepMatch[1]!, label: stepMatch[1]!, counterLimit: stepMatch[2] ? Number(stepMatch[2]) : null })
      index += stepMatch[0].length
      continue
    }

    if (rest.startsWith('[if ')) {
      const close = findBracketClose(rest)
      if (close !== -1) {
        const condition = parseConditionBody(rest.slice('[if '.length, close))
        if (condition) { flush(); segments.push(condition); index += close + 1; continue }
      }
    }

    if (rest.startsWith('[outcome ')) {
      const close = findBracketClose(rest)
      if (close !== -1) {
        const status = rest.slice('[outcome '.length, close).trim()
        if (status) { flush(); segments.push({ kind: 'chip', chipKind: 'condition', refId: OUTCOME_GUARD_REF, value: status, label: `outcome is ${status}` }); index += close + 1; continue }
      }
    }

    if (rest.startsWith('[filled ')) {
      const close = findBracketClose(rest)
      if (close !== -1) {
        // `[filled @x, @y]` → a slot-filled guard: the slot keys ride in `values`.
        const keys = rest.slice('[filled '.length, close)
          .split(',')
          .map((part) => part.trim().replace(/^@/, ''))
          .filter((key) => key.length > 0)
        if (keys.length > 0) { flush(); segments.push({ kind: 'chip', chipKind: 'condition', refId: SLOT_FILLED_GUARD_REF, values: keys, label: `when ${keys.join(', ')} provided` }); index += close + 1; continue }
      }
    }

    if (rest.startsWith('[action ')) {
      const close = findBracketClose(rest)
      if (close !== -1) {
        const actionRef = parseActionBody(rest.slice('[action '.length, close))
        if (actionRef) { flush(); segments.push({ kind: 'chip', chipKind: 'action', refId: actionRef, label: actionRef }); index += close + 1; continue }
      }
    }

    if (rest.startsWith('[decision ') || rest.startsWith('[approval ')) {
      const close = findBracketClose(rest)
      if (close !== -1) {
        const chipKind = rest.startsWith('[decision ') ? 'decision' as const : 'approval' as const
        const gate = parseGateBody(chipKind, rest.slice(`[${chipKind} `.length, close))
        if (gate) { flush(); segments.push(gate); index += close + 1; continue }
      }
    }

    if (rest.startsWith('#')) {
      // A skill: `#skill_name` with an optional `[bindings]` suffix. The `#` prefix marks a
      // capability unambiguously (a heading is `# ` with a space, handled a level up).
      const idMatch = IDENTIFIER.exec(rest.slice(1))
      if (idMatch) {
        const refId = idMatch[0]
        const consumed = 1 + refId.length
        if (rest[consumed] === '[') {
          const close = rest.indexOf(']', consumed)
          if (close !== -1) {
            const bindings = parseSkillSuffix(rest.slice(consumed + 1, close))
            flush()
            segments.push({ kind: 'chip', chipKind: 'skill', refId, label: refId, ...bindings })
            index += close + 1
            continue
          }
        }
        flush()
        segments.push({ kind: 'chip', chipKind: 'skill', refId, label: refId })
        index += consumed
        continue
      }
    }

    if (rest.startsWith('@')) {
      const idMatch = IDENTIFIER.exec(rest.slice(1))
      if (idMatch) {
        // Trailing sentence punctuation isn't part of the ref — leave it as text so
        // `record as @name.` keeps the period (mirrors the backend mention rule).
        const refId = idMatch[0].replace(/[.,;:!?]+$/, '')
        const consumed = 1 + refId.length
        if (refId === '') { buffer += line[index]; index += 1; continue }
        const kind = resolveKind(refId)
        if (kind === 'skill' && rest[consumed] === '[') {
          const close = rest.indexOf(']', consumed)
          if (close !== -1) {
            const bindings = parseSkillSuffix(rest.slice(consumed + 1, close))
            flush()
            segments.push({ kind: 'chip', chipKind: 'skill', refId, label: refId, ...bindings })
            index += close + 1
            continue
          }
        }
        flush()
        segments.push(kind === 'skill'
          ? { kind: 'chip', chipKind: 'skill', refId, label: refId }
          : { kind: 'chip', chipKind: 'variable', refId, label: `@${refId}` })
        index += consumed
        continue
      }
    }

    buffer += line[index]
    index += 1
  }
  flush()
  return segments.length > 0 ? segments : [{ kind: 'text', text: '' }]
}

// True when pasted text carries our frontmatter fence or any chip token — the signal that
// the editor should reconstruct a routine rather than insert the text literally.
export const looksLikeRoutineProse = (text: string): boolean => {
  const trimmed = text.trim()
  if (trimmed.startsWith(`${FENCE}\nname:`) || trimmed.startsWith(`${FENCE}\r\nname:`)) return true
  if (trimmed.startsWith(`${FENCE}\ngrammar:`) || trimmed.startsWith(`${FENCE}\r\ngrammar:`)) return true
  return /(^|\s)(-> (end|handoff|step:)|\[(if|outcome|filled|action|decision|approval) )/.test(text)
    || /(^|\s)@[A-Za-z_]/.test(text)
    // A skill mention `#name` (but not a `# ` heading, which has a space after the hash).
    || /(^|\s)#[A-Za-z_]/.test(text)
}

export const parseProseDoc = (
  text: string,
  resolveSkill: (name: string) => boolean,
): ParsedProseDoc => {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let name: string | null = null
  let trigger: string | null = null
  let reentryMode: RoutineReentryMode = 'once_per_conversation'
  let priority = 0
  let completionExport: RoutineCompletionExport | undefined
  let hadFrontmatter = false
  let grammarVersion = GRAMMAR_VERSION
  const declaredTypes = new Map<string, RoutineSlotType>()
  const declaredOrder: string[] = []
  // Slot flags declared alongside the type (`key:type:optional:mutable`). Absent = default
  // (required, non-mutable), so we only record the non-default flags we actually saw.
  const declaredFlags = new Map<string, { required?: boolean; mutable?: boolean }>()

  let bodyStart = 0
  if (lines[0]?.trim() === FENCE) {
    let cursor = 1
    while (cursor < lines.length && lines[cursor]!.trim() !== FENCE) {
      const line = lines[cursor]!
      const sep = line.indexOf(':')
      if (sep !== -1) {
        const key = line.slice(0, sep).trim()
        const value = line.slice(sep + 1).trim()
        if (key === 'grammar') {
          const parsed = Number(value)
          if (Number.isInteger(parsed)) grammarVersion = parsed
        } else if (key === 'name') { name = value; hadFrontmatter = true }
        else if (key === 'trigger') { trigger = value; hadFrontmatter = true }
        else if (key === 'reentry') {
          const parsed = parseReentryMode(value)
          if (!parsed) continue
          reentryMode = parsed
          hadFrontmatter = true
        }
        else if (key === 'priority') {
          const parsed = Number(value)
          if (Number.isInteger(parsed)) {
            priority = parsed
            hadFrontmatter = true
          }
        }
        else if (key === 'export') {
          completionExport = parseExport(value) ?? undefined
          hadFrontmatter = true
        }
        else if (key === 'vars') {
          hadFrontmatter = true
          for (const declaration of splitList(value)) {
            const [varKey, varType, ...flags] = declaration.split(':').map((part) => part.trim())
            if (varKey && varType && (SLOT_TYPES as readonly string[]).includes(varType)) {
              if (!declaredTypes.has(varKey)) declaredOrder.push(varKey)
              declaredTypes.set(varKey, varType as RoutineSlotType)
              const required = flags.includes('optional') ? false : undefined
              const mutable = flags.includes('mutable') ? true : undefined
              if (required !== undefined || mutable !== undefined) {
                declaredFlags.set(varKey, {
                  ...(required !== undefined ? { required } : {}),
                  ...(mutable !== undefined ? { mutable } : {}),
                })
              }
            }
          }
        }
      }
      cursor += 1
    }
    bodyStart = cursor < lines.length ? cursor + 1 : cursor
  }

  const resolveKind = (refName: string): ProseChipKind => (resolveSkill(refName) ? 'skill' : 'variable')

  const paragraphs: ProseParagraph[] = []
  for (const raw of lines.slice(bodyStart)) {
    const isHeading = raw.startsWith('# ')
    const content = isHeading ? raw.slice(2) : raw
    paragraphs.push({
      ...(isHeading ? { headingLevel: 1 as const } : {}),
      segments: parseSegments(content, resolveKind),
    })
  }
  // A trailing blank line from the join shouldn't add an empty paragraph.
  while (paragraphs.length > 1) {
    const last = paragraphs[paragraphs.length - 1]!
    if (last.headingLevel || last.segments.some((segment) => segment.kind !== 'text' || segment.text !== '')) break
    paragraphs.pop()
  }

  // Variables = declared variables first, then anything referenced only in the body. This
  // preserves declared-but-unused slots so backend validation can decide the policy.
  const referenced = referencedVariableIds(paragraphs)
  const variableIds = [...declaredOrder]
  for (const id of referenced) {
    if (!declaredTypes.has(id)) variableIds.push(id)
  }
  const variables: ChipDocVariable[] = variableIds.map((id) => ({
    id,
    name: id,
    type: declaredTypes.get(id) ?? 'text',
    ...declaredFlags.get(id),
  }))

  void grammarVersion
  return { name, trigger, reentryMode, priority, ...(completionExport ? { completionExport } : {}), variables, paragraphs, hadFrontmatter }
}

const grammarVersionDiagnostic = (version: number, line: number): ParseDiagnostic => ({
  line,
  code: 'unsupported_grammar_version',
  message: `Unsupported routine grammar version: ${version}`,
})

const invalidReentryDiagnostic = (value: string, line: number): ParseDiagnostic => ({
  line,
  code: 'invalid_reentry',
  message: `Unsupported routine reentry mode: ${value}`,
})

const invalidPriorityDiagnostic = (value: string, line: number): ParseDiagnostic => ({
  line,
  code: 'invalid_priority',
  message: `Routine priority must be an integer: ${value}`,
})

const unknownFrontmatterKeyDiagnostic = (key: string, line: number): ParseDiagnostic => ({
  line,
  code: 'unknown_frontmatter_key',
  message: `Unknown routine frontmatter key: ${key}`,
})

const invalidExportDiagnostic = (line: number): ParseDiagnostic => ({
  line,
  code: 'invalid_export',
  message: 'Routine export must be "<triggerKinds> -> <destinationRef>" with trigger kinds complete and/or handoff',
})

const unknownBracketTokenDiagnostic = (token: string, line: number): ParseDiagnostic => ({
  line,
  code: 'unknown_bracket_token',
  message: `Unknown routine bracket token: ${token}`,
})

const bracketTokenIsKnown = (body: string): boolean => {
  const trimmed = body.trim()
  return trimmed.startsWith('if ')
    || trimmed.startsWith('outcome ')
    || trimmed.startsWith('filled ')
    || trimmed.startsWith('action ')
    || trimmed.startsWith('decision ')
    || trimmed.startsWith('approval ')
}

const readBodyBracketDiagnostics = (lines: string[], bodyStart: number): ParseDiagnostic[] => {
  const diagnostics: ParseDiagnostic[] = []
  for (let lineIndex = bodyStart; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!
    let cursor = 0
    while (cursor < line.length) {
      const open = line.indexOf('[', cursor)
      if (open === -1) break
      const previous = open > 0 ? line[open - 1] : ''
      if (previous && /[A-Za-z0-9_.-]/.test(previous)) {
        cursor = open + 1
        continue
      }
      const close = findBracketClose(line.slice(open))
      if (close === -1) break
      const token = line.slice(open, open + close + 1)
      if (!bracketTokenIsKnown(token.slice(1, -1))) {
        diagnostics.push(unknownBracketTokenDiagnostic(token, lineIndex + 1))
      }
      cursor = open + close + 1
    }
  }
  return diagnostics
}

const readFrontmatterDiagnostics = (text: string): { version: number; bodyStart: number; diagnostics: ParseDiagnostic[] } => {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== FENCE) return { version: GRAMMAR_VERSION, bodyStart: 0, diagnostics: [] }

  let version = GRAMMAR_VERSION
  const diagnostics: ParseDiagnostic[] = []
  let cursor = 1
  while (cursor < lines.length && lines[cursor]!.trim() !== FENCE) {
    const line = lines[cursor]!
    const sep = line.indexOf(':')
    if (sep !== -1) {
      const key = line.slice(0, sep).trim()
      const value = line.slice(sep + 1).trim()
      if (!FRONTMATTER_KEYS.has(key)) {
        diagnostics.push(unknownFrontmatterKeyDiagnostic(key, cursor + 1))
      } else if (key === 'grammar') {
        const parsed = Number(value)
        version = Number.isInteger(parsed) ? parsed : Number.NaN
        if (version !== GRAMMAR_VERSION) diagnostics.push(grammarVersionDiagnostic(version, cursor + 1))
      } else if (key === 'reentry') {
        if (!parseReentryMode(value)) {
          diagnostics.push(invalidReentryDiagnostic(value, cursor + 1))
        }
      } else if (key === 'priority') {
        const parsed = Number(value)
        if (!Number.isInteger(parsed)) diagnostics.push(invalidPriorityDiagnostic(value, cursor + 1))
      } else if (key === 'export') {
        if (!parseExport(value)) diagnostics.push(invalidExportDiagnostic(cursor + 1))
      }
    }
    cursor += 1
  }
  const bodyStart = cursor < lines.length ? cursor + 1 : cursor
  diagnostics.push(...readBodyBracketDiagnostics(lines, bodyStart))
  return { version, bodyStart, diagnostics }
}

export const parse = (
  content: string,
  options: { resolveSkill?: (name: string) => boolean } = {},
): ParseResult => {
  const version = readFrontmatterDiagnostics(content)
  if (version.diagnostics.length > 0) return { ok: false, diagnostics: version.diagnostics }
  return {
    ok: true,
    grammarVersion: GRAMMAR_VERSION,
    doc: parseProseDoc(content, options.resolveSkill ?? (() => false)),
  }
}

export const serialize = serializeProseDoc

export const canonicalize = (
  content: string,
  options: { resolveSkill?: (name: string) => boolean } = {},
): CanonicalizeResult => {
  const parsed = parse(content, options)
  if (!parsed.ok) return parsed
  return {
    ok: true,
    grammarVersion: GRAMMAR_VERSION,
    content: serializeProseDoc({
      name: parsed.doc.name ?? '',
      trigger: parsed.doc.trigger ?? '',
      reentryMode: parsed.doc.reentryMode,
      priority: parsed.doc.priority,
      completionExport: parsed.doc.completionExport,
      variables: parsed.doc.variables,
      paragraphs: parsed.doc.paragraphs,
    }),
  }
}
