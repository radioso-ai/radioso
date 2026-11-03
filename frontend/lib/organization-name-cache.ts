// The organization name shown before the account request answers, kept per account in local storage.
const getOrganizationNameCacheKey = (accountId: string) => `radioso.organizationName:${accountId}`

export const readCachedOrganizationName = (accountId: string) => {
  if (typeof window === 'undefined') {
    return ''
  }

  const cachedValue = window.localStorage.getItem(getOrganizationNameCacheKey(accountId))
  return typeof cachedValue === 'string' ? cachedValue : ''
}

export const writeCachedOrganizationName = (accountId: string, organizationName: string) => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(getOrganizationNameCacheKey(accountId), organizationName)
}
