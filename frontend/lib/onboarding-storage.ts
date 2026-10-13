const ONBOARDING_ANALYTICS_MARKERS_KEY = 'radioso.onboardingAnalyticsMarkers'

type OnboardingAnalyticsMarker =
  | 'documents_added'
  | 'documents_processed'
  | 'sample_imported'
  | 'first_question'
  | 'first_question_step_completed'
type OnboardingAnalyticsMarkerMap = Record<string, Partial<Record<OnboardingAnalyticsMarker, true>>>

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
