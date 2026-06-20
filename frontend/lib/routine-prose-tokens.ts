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
  ChipDocVariable,
  ProseChipKind,
  ProseParagraph,
  ProseSegment,
  RoutineInputBinding,
  RoutineStepMode,
} from './routine-prose'
import type { RoutineFieldGuardOp, RoutineFieldGuardUnit, RoutineSlotType } from './api-types'

export type RoutineFieldGuardValue = string | number | boolean

export type ParsedProseDoc = {
  name: string | null
  trigger: string | null
  variables: ChipDocVariable[]
  paragraphs: ProseParagraph[]
}

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

const formatBinding = (binding: RoutineInputBinding): string =>
  binding.kind === 'variableRef' ? `@${binding.ref}` : formatLiteral(binding.value)

// A skill chip carries optional typed bindings (spec 090). They have no inline form in
// prose, so they ride in a bracket suffix that only appears when non-default — an unbound
// skill stays a clean `@skill_name`.
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
  const op = chip.op
  if (!op) return `[if ${chip.refId}]`
  const token = OP_TOKENS[op]
  if (!opNeedsValue(op)) return `[if ${chip.refId} ${token}]`
  if (op === 'in') return `[if ${chip.refId} in ${(chip.values ?? []).map(formatLiteral).join(', ')}]`
  if (opNeedsUnit(op)) return `[if ${chip.refId} ${token} ${formatLiteral(chip.value ?? '')} ${chip.unit ?? ''}]`.replace(/\s+/g, ' ').trimEnd()
  return `[if ${chip.refId} ${token} ${formatLiteral(chip.value ?? '')}]`
}

// One chip → its canonical inline token. Shared by the editor's copy path (live node) and
// document serialization (parsed segment).
export const tokenForChip = (chip: ChipTokenInput): string => {
  switch (chip.chipKind) {
    case 'variable':
      return `@${chip.refId}`
    case 'skill':
      return `@${chip.refId}${formatSkillSuffix(chip)}`
    case 'end':
      return '-> end'
    case 'handoff':
      return '-> handoff'
    case 'step':
      return `-> step:${chip.refId}${chip.counterLimit != null ? ` (max ${chip.counterLimit})` : ''}`
    case 'condition':
      return formatConditionToken(chip)
    default:
      return ''
  }
}

const formatParagraph = (paragraph: ProseParagraph): string => {
  const body = paragraph.segments
    .map((segment) => (segment.kind === 'text' ? segment.text : tokenForChip(segment)))
    .join('')
  return paragraph.headingLevel === 1 ? `# ${body}` : body
}

const referencedVariableIds = (paragraphs: ProseParagraph[]): Set<string> => {
  const ids = new Set<string>()
  for (const paragraph of paragraphs) {
    for (const segment of paragraph.segments) {
      if (segment.kind !== 'chip') continue
      if (segment.chipKind === 'variable' || segment.chipKind === 'condition') ids.add(segment.refId)
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
  variables: ChipDocVariable[]
  paragraphs: ProseParagraph[]
}): string => {
  const referenced = referencedVariableIds(input.paragraphs)
  // Only non-default-typed variables need a declaration — a plain `@name` round-trips as
  // text, so we don't clutter the header with the common case.
  const typedVars = input.variables.filter((variable) => referenced.has(variable.id) && variable.type !== 'text')

  const front = [FENCE, `name: ${input.name}`, `trigger: ${input.trigger}`]
  if (typedVars.length > 0) {
    front.push(`vars: ${typedVars.map((variable) => `${variable.id}:${variable.type}`).join(', ')}`)
  }
  front.push(FENCE)

  return [...front, ...input.paragraphs.map(formatParagraph)].join('\n')
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
  return { kind: 'literal', value: coerceLiteral(trimmed) }
}

const splitList = (raw: string): string[] =>
  raw.split(',').map((part) => part.trim()).filter((part) => part !== '')

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
  while (index < line.length) {
    const rest = line.slice(index)

    if (rest.startsWith('-> end')) { flush(); segments.push({ kind: 'chip', chipKind: 'end', refId: 'done', label: 'end' }); index += '-> end'.length; continue }
    if (rest.startsWith('-> handoff')) { flush(); segments.push({ kind: 'chip', chipKind: 'handoff', refId: 'handoff', label: 'handoff' }); index += '-> handoff'.length; continue }

    const stepMatch = /^-> step:([A-Za-z_][A-Za-z0-9_.-]*)(?:\s*\(max (\d+)\))?/.exec(rest)
    if (stepMatch) {
      flush()
      segments.push({ kind: 'chip', chipKind: 'step', refId: stepMatch[1]!, label: stepMatch[1]!, counterLimit: stepMatch[2] ? Number(stepMatch[2]) : null })
      index += stepMatch[0].length
      continue
    }

    if (rest.startsWith('[if ')) {
      const close = rest.indexOf(']')
      if (close !== -1) {
        const condition = parseConditionBody(rest.slice('[if '.length, close))
        if (condition) { flush(); segments.push(condition); index += close + 1; continue }
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
  return /(^|\s)(-> (end|handoff|step:)|\[if )/.test(text) || /(^|\s)@[A-Za-z_]/.test(text)
}

export const parseProseDoc = (
  text: string,
  resolveSkill: (name: string) => boolean,
): ParsedProseDoc => {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let name: string | null = null
  let trigger: string | null = null
  const declaredTypes = new Map<string, RoutineSlotType>()

  let bodyStart = 0
  if (lines[0]?.trim() === FENCE) {
    let cursor = 1
    while (cursor < lines.length && lines[cursor]!.trim() !== FENCE) {
      const line = lines[cursor]!
      const sep = line.indexOf(':')
      if (sep !== -1) {
        const key = line.slice(0, sep).trim()
        const value = line.slice(sep + 1).trim()
        if (key === 'name') name = value
        else if (key === 'trigger') trigger = value
        else if (key === 'vars') {
          for (const declaration of splitList(value)) {
            const [varKey, varType] = declaration.split(':').map((part) => part.trim())
            if (varKey && varType && (SLOT_TYPES as readonly string[]).includes(varType)) {
              declaredTypes.set(varKey, varType as RoutineSlotType)
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

  // Variables = everything referenced, typed from the `vars:` declaration (default text).
  const referenced = referencedVariableIds(paragraphs)
  const variables: ChipDocVariable[] = [...referenced].map((id) => ({
    id,
    name: id,
    type: declaredTypes.get(id) ?? 'text',
  }))

  return { name, trigger, variables, paragraphs }
}
