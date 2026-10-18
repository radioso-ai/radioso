type BillingSubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'none'

// An active or past-due subscriber changes plan through Stripe's customer portal, which updates
// the existing subscription; a new checkout would create a second subscription.
export const planUpgradeDestination = (
  subscriptionStatus: BillingSubscriptionStatus,
): 'portal' | 'checkout' =>
  subscriptionStatus === 'active' || subscriptionStatus === 'past_due' ? 'portal' : 'checkout'
