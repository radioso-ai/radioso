const ONBOARDING_ACTIVE_KEY = 'radioso.onboardingActive'
const ONBOARDING_COMPLETED_KEY = 'radioso.onboardingCompleted'

type OnboardingStorageMap = Record<string, boolean>

const readBooleanMap = (key: string): OnboardingStorageMap => {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return {}
    }

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
    )
  } catch {
    return {}
  }
}

const writeBooleanMap = (key: string, value: OnboardingStorageMap) => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(key, JSON.stringify(value))
}

const setWorkspaceFlag = (key: string, workspaceId: string, enabled: boolean) => {
  const next = readBooleanMap(key)
  if (enabled) {
    next[workspaceId] = true
  } else {
    delete next[workspaceId]
  }
  writeBooleanMap(key, next)
}

export const isOnboardingActive = (workspaceId: string) => readBooleanMap(ONBOARDING_ACTIVE_KEY)[workspaceId] === true

export const isOnboardingCompleted = (workspaceId: string) =>
  readBooleanMap(ONBOARDING_COMPLETED_KEY)[workspaceId] === true

export const markOnboardingActive = (workspaceId: string) => {
  setWorkspaceFlag(ONBOARDING_ACTIVE_KEY, workspaceId, true)
}

export const markOnboardingCompleted = (workspaceId: string) => {
  setWorkspaceFlag(ONBOARDING_COMPLETED_KEY, workspaceId, true)
  setWorkspaceFlag(ONBOARDING_ACTIVE_KEY, workspaceId, false)
}
