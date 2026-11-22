import type { ContextVariable, ContextVariableCreateRequest, ContextVariableSource, ContextVariableSurfacing, ContextVariableValueType } from '@/lib/api'

export type SourceOption = ContextVariableSource
export type SurfacingOption = ContextVariableSurfacing
export type ValueTypeOption = ContextVariableValueType

export type AdvancedAttributeSettings = Pick<
  ContextVariableCreateRequest,
  'trustTier' | 'sensitivity' | 'defaultSurfacing'
>

export const defaultAdvancedSettings: AdvancedAttributeSettings = {
  trustTier: 'unverified',
  sensitivity: 'normal',
  defaultSurfacing: 'on_reference',
}

export const sourceLabels: Record<SourceOption, string> = {
  pushed: 'Your website or API',
  classified: 'The AI, from the conversation',
}

/** How many attributes one agent can have the AI set; the backend holds the same limit. */
const MAX_CLASSIFIED_PER_AGENT = 8

/** Why the AI can't set this attribute on this agent, or null when it can. */
export const classifiedUnavailableReason = (
  variable: Pick<ContextVariable, 'valueType' | 'sensitivity' | 'trustTier'>,
  classifiedElsewhere: number,
): string | null => {
  if (variable.valueType !== 'enum') return 'Choice attributes only'
  if (variable.sensitivity === 'sensitive') return 'Not for Private attributes'
  if (variable.trustTier === 'signed') return 'Not for attributes treated as proof'
  if (classifiedElsewhere >= MAX_CLASSIFIED_PER_AGENT) return `Up to ${MAX_CLASSIFIED_PER_AGENT} per agent`
  return null
}

export const surfacingLabels: Record<SurfacingOption, string> = {
  always: 'Every reply, and rules, routines and skills',
  on_reference: 'Only rules, routines and skills that name it',
  operator_only: 'Only your team',
}

export const valueTypeLabels: Record<ValueTypeOption, string> = {
  string: 'Text',
  json: 'JSON',
  enum: 'Choice',
}

export const attributeHelp = {
  name: {
    description: 'How the agent, routines and the API refer to this attribute.',
    tooltip:
      'The identifier rules, routines and your API use to read this value, for example `@cart`. Use letters, numbers and underscores, and start with a letter. Visitors never see it.',
  },
  description: {
    description: 'What this value holds.',
    tooltip:
      'A short description that helps your team and the agent recognise the value. It does not change behaviour.',
  },
  valueType: {
    description: 'Text, one of your options, or structured data.',
    tooltip:
      '**Text** is a single value, such as a plan name.\n\n**Choice** is one option from a list you write, such as a topic. A value stores the option key.\n\n**JSON** is structured data your site sends, such as a cart with line items.\n\nThe type cannot change once the attribute has values.',
  },
  signed: {
    description: 'Skills that need a verified identity accept this value. Tick it only if your server alone sets the value.',
    tooltip:
      'Skill inputs that require a verified identity accept only values marked as proof. Radioso does not check a signature on the value itself, so tick this only when your server is the only thing that sets it, for example the customer\u2019s plan.\n\nUnticked, the value is a hint: a visitor could fake it.',
  },
  private: {
    description: 'Masked in logs, history and rule checks. The agent still sees it in replies where an agent\u2019s Used by is \u201cevery reply\u201d.',
    tooltip:
      'A private value is masked in logs and stored history, and rules see `[redacted]` instead of it.\n\nThe agent still sees it in replies wherever its **Used by** is \u201cEvery reply, and rules, routines and skills\u201d. Set an agent\u2019s Used by to another option to keep it out of the reply.',
  },
  usedBy: {
    description: 'Each agent sets its own on its card.',
    tooltip:
      'This is the default each agent starts with.\n\n**Every reply, and rules, routines and skills**: the agent reads the value on each turn, and rules, routines and skills can use it.\n\n**Only rules, routines and skills that name it**: used only where a rule, a routine step (`{{context.name}}`) or a skill input refers to it. The agent does not read it in replies.\n\n**Only your team**: never in a reply or routine text. Rules can still check it, and your team sees it.',
  },
  setBy: {
    tooltip:
      '**Your website or API**: your backend or page sends the value through the Radioso API, and Radioso keeps it per conversation, session or customer.\n\n**The AI, from the conversation**: after each reply, the AI picks one of your options from what the visitor wrote, or none. Rules and routines read it from the next turn. It never replaces a value your team or your API set for this visitor or conversation; agent-wide and workspace-wide values are defaults until the AI picks one. Choice attributes that aren\u2019t Private or treated as proof only.',
  },
} as const
