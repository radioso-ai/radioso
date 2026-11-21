import type {
  AgentContextVariableEnablementRequest,
  ContextVariableCreateRequest,
} from '@/lib/api'

export type SourceOption = Extract<AgentContextVariableEnablementRequest['source'], 'pushed'>
export type SurfacingOption = AgentContextVariableEnablementRequest['surfacing']
export type ValueTypeOption = ContextVariableCreateRequest['valueType']

export const sourceLabels: Record<SourceOption, string> = {
  pushed: 'Your website or API',
}

export const surfacingLabels: Record<SurfacingOption, string> = {
  always: 'The agent, in every reply',
  on_reference: 'Rules, routines and skills that name it',
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
    description: 'Accept the value only when your server signs it.',
    tooltip:
      'Use it for facts that prove something, such as the customer’s plan. Skill inputs that need verified identity accept only signed values.\n\nUnsigned values are hints: a visitor could fake them.',
  },
  private: {
    description: 'Masked in logs, history and rule checks. The agent still sees it in replies if "Used by" allows.',
    tooltip:
      'A private value is masked in logs and stored history, and rules see `[redacted]` instead of it.\n\nThe agent still sees it in replies when **Used by** is “The agent, in every reply”. Pick another option to keep it out of the reply.',
  },
  usedBy: {
    description: 'Where the value is used. Each agent can change this.',
    tooltip:
      '**The agent, in every reply**: the value is part of what the agent reads on each turn.\n\n**Rules, routines and skills that name it**: used only where a rule, a routine step (`{{context.name}}`) or a skill input refers to it.\n\n**Only your team**: never in a reply or routine text. Rules can still check it, and your team sees it.\n\nEach agent can override this on its own card.',
  },
  setBy: {
    tooltip:
      '**Your website or API**: your backend or page sends the value through the Radioso API, and Radioso keeps it per conversation, session or customer.',
  },
} as const
