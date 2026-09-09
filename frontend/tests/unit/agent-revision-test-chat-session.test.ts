import { beforeEach, describe, expect, it } from 'vitest'

import {
  activateAgentRevisionTestChatSessionScope,
  agentRevisionTestChatSessionKey,
  disposeAllAgentRevisionTestChatSessions,
  endAgentRevisionTestChatAuthSession,
  readAgentRevisionTestChatSession,
  startAgentRevisionTestChatSession,
  writeAgentRevisionTestChatSession,
  type AgentRevisionTestChatSession,
} from '@/lib/agent-revision-test-chat-session'

const session = (): AgentRevisionTestChatSession => ({
  state: null,
  revisions: [],
  mode: 'single',
  view: 'chat',
  selected: [],
  message: 'private composer text',
  execution: null,
  evalRun: null,
  error: null,
  cases: [],
  selectedCaseIds: [],
  restartNotice: null,
  revisionDetails: {},
  contextVariables: [],
  valueInputs: {},
  valueError: null,
  isSending: false,
  isStarting: false,
  isRunningEvals: false,
  retryingEvalCase: null,
  proactiveStartKey: null,
  executionEpoch: 0,
})

describe('agent revision test chat session', () => {
  beforeEach(() => disposeAllAgentRevisionTestChatSessions())

  it('keeps a browser-tab session while its account and workspace scope stay active', () => {
    const key = agentRevisionTestChatSessionKey('workspace-1', 'agent-1')
    activateAgentRevisionTestChatSessionScope('account-1', 'workspace-1')
    startAgentRevisionTestChatSession(key, session())

    activateAgentRevisionTestChatSessionScope('account-1', 'workspace-1')

    expect(readAgentRevisionTestChatSession(key)?.message).toBe('private composer text')
  })

  it('drops sessions on account/workspace replacement and ignores stale writers', () => {
    const key = agentRevisionTestChatSessionKey('workspace-1', 'agent-1')
    activateAgentRevisionTestChatSessionScope('account-1', 'workspace-1')
    startAgentRevisionTestChatSession(key, session())

    activateAgentRevisionTestChatSessionScope('account-1', 'workspace-2')
    writeAgentRevisionTestChatSession(key, { message: 'late stream write' })

    expect(readAgentRevisionTestChatSession(key)).toBeUndefined()
    activateAgentRevisionTestChatSessionScope('account-2', 'workspace-2')
    expect(readAgentRevisionTestChatSession(key)).toBeUndefined()
  })

  it('clears private content when the auth session ends', () => {
    const key = agentRevisionTestChatSessionKey('workspace-1', 'agent-1')
    activateAgentRevisionTestChatSessionScope('account-1', 'workspace-1')
    startAgentRevisionTestChatSession(key, session())

    endAgentRevisionTestChatAuthSession()

    expect(readAgentRevisionTestChatSession(key)).toBeUndefined()
  })
})
