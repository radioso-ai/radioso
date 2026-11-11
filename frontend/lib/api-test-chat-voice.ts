import { request } from './api-client'
import { voiceSessionStartOf } from './api-public-voice'
import type { VoiceSessionStart } from './voice-call'

/**
 * Asks Radioso to start a voice session on one of the operator's private tests, with the dashboard
 * session: the call's turns run on the test's revision and are recorded in the test as spoken. A
 * refused or failed start reads as `refused`, as the website embed's does; the call says it could not
 * start. The answer carries the vendor's signed URL, so the request carries the CSRF header.
 */
export async function startTestChatVoiceSession(agentId: string, executionId: string): Promise<VoiceSessionStart> {
  try {
    const body = await request<unknown>(
      `/agents/${encodeURIComponent(agentId)}/test-executions/${encodeURIComponent(executionId)}/voice-sessions`,
      { method: 'POST', headers: { 'X-Radioso-CSRF': '1' }, body: JSON.stringify({}) },
      { withSession: true },
    )
    return voiceSessionStartOf(body)
  } catch {
    return { kind: 'refused' }
  }
}
