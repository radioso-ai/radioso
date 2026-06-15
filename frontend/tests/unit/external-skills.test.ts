import { describe, expect, it } from 'vitest'

import {
  buildExternalSkillDraft,
  defaultParamModes,
  defaultSkillName,
  getToolInputFields,
  normalizeSkillName,
} from '@/lib/external-skills'

describe('external skills helpers', () => {
  const schema = {
    type: 'object',
    required: ['message'],
    properties: {
      channel: { type: 'string', description: 'Destination channel' },
      message: { type: 'string', description: 'Message text' },
      urgent: { type: 'boolean' },
      retry_count: { type: 'integer' },
    },
  }

  it('derives ordered tool input fields from JSON Schema', () => {
    expect(getToolInputFields(schema)).toEqual([
      { name: 'message', type: 'string', description: 'Message text', required: true },
      { name: 'channel', type: 'string', description: 'Destination channel', required: false },
      { name: 'retry_count', type: 'number', description: null, required: false },
      { name: 'urgent', type: 'boolean', description: null, required: false },
    ])
  })

  it('defaults required params to exposed and optional params to ignored', () => {
    expect(defaultParamModes(getToolInputFields(schema))).toEqual({
      message: 'expose',
      channel: 'ignore',
      retry_count: 'ignore',
      urgent: 'ignore',
    })
  })

  it('normalizes tool names into routine skill identifiers', () => {
    expect(defaultSkillName('Post Message')).toBe('post_message')
    expect(normalizeSkillName('123 calendar.create')).toBe('skill_123_calendar_create')
  })

  it('builds a create payload with typed bound params and exposed specs', () => {
    expect(buildExternalSkillDraft({
      skillName: 'Post Message',
      connectionId: '0c7b8fd2-f567-4bb2-bb5b-a6c7b174c7a2',
      tool: { name: 'post_message', inputSchema: schema },
      paramModes: {
        channel: 'bind',
        message: 'expose',
        urgent: 'bind',
        retry_count: 'bind',
      },
      boundValues: {
        channel: '#support',
        urgent: 'true',
        retry_count: '2',
      },
      exposedParams: {
        message: { description: 'The message to send', slotBinding: 'Support Message' },
      },
    })).toEqual({
      skillName: 'post_message',
      connectionId: '0c7b8fd2-f567-4bb2-bb5b-a6c7b174c7a2',
      toolName: 'post_message',
      boundParams: {
        channel: '#support',
        urgent: true,
        retry_count: 2,
      },
      exposedParams: {
        message: {
          description: 'The message to send',
          slotBinding: 'support_message',
        },
      },
      enabled: true,
    })
  })
})
