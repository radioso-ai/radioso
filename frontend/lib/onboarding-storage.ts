const ONBOARDING_ACTIVE_KEY = 'radioso.onboardingActive'
const ONBOARDING_COMPLETED_KEY = 'radioso.onboardingCompleted'
const ONBOARDING_ANALYTICS_MARKERS_KEY = 'radioso.onboardingAnalyticsMarkers'

type OnboardingStorageMap = Record<string, boolean>
type OnboardingAnalyticsMarker =
  | 'documents_added'
  | 'documents_processed'
  | 'sample_imported'
  | 'first_question'
  | 'first_question_step_completed'
type OnboardingAnalyticsMarkerMap = Record<string, Partial<Record<OnboardingAnalyticsMarker, true>>>

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

const readOnboardingAnalyticsMarkers = (): OnboardingAnalyticsMarkerMap => {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(ONBOARDING_ANALYTICS_MARKERS_KEY)
    const parsed = raw ? JSON.parse(raw) as unknown : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return Object.fromEntries(
      Object.entries(parsed).flatMap(([workspaceId, markers]) => {
        if (!markers || typeof markers !== 'object' || Array.isArray(markers)) {
          return []
        }

        const enabledMarkers = Object.fromEntries(
          Object.entries(markers).filter((entry): entry is [OnboardingAnalyticsMarker, true] => entry[1] === true),
        )
        return Object.keys(enabledMarkers).length > 0 ? [[workspaceId, enabledMarkers]] : []
      }),
    )
  } catch {
    return {}
  }
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
  setWorkspaceFlag(ONBOARDING_COMPLETED_KEY, workspaceId, false)
  setWorkspaceFlag(ONBOARDING_ACTIVE_KEY, workspaceId, true)
}

export const markOnboardingCompleted = (workspaceId: string) => {
  setWorkspaceFlag(ONBOARDING_COMPLETED_KEY, workspaceId, true)
  setWorkspaceFlag(ONBOARDING_ACTIVE_KEY, workspaceId, false)
}

export const hasOnboardingAnalyticsMarker = (workspaceId: string, marker: OnboardingAnalyticsMarker): boolean =>
  readOnboardingAnalyticsMarkers()[workspaceId]?.[marker] === true

export const markOnboardingAnalyticsMarker = (workspaceId: string, marker: OnboardingAnalyticsMarker) => {
  if (typeof window === 'undefined') {
    return
  }

  const markers = readOnboardingAnalyticsMarkers()
  markers[workspaceId] = { ...markers[workspaceId], [marker]: true }
  window.localStorage.setItem(ONBOARDING_ANALYTICS_MARKERS_KEY, JSON.stringify(markers))
}
