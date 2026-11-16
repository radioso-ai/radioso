import type { WebhookDestination } from '@/lib/api'

export const webhookDestinationRowDomId = (destinationId: string): string => `webhook-destination-${destinationId}`

export const formatDeliveryStatus = (destination: WebhookDestination): string => {
  if (!destination.lastDeliveryStatus || !destination.lastDeliveryAt) {
    return 'No deliveries yet'
  }
  const status = destination.lastDeliveryStatus.replace(/_/gu, ' ')
  return `${status} at ${new Date(destination.lastDeliveryAt).toLocaleString()}`
}

// A success is the normal state and a skip is a routine's own choice, so neither is flagged.
// Only a delivery that is failing, or still being retried, is worth interrupting the list for.
const ATTENTION_LABELS: Partial<Record<NonNullable<WebhookDestination['lastDeliveryStatus']>, string>> = {
  failed: 'Failing',
  retry: 'Retrying',
}

export const deliveryAttentionLabel = (destination: WebhookDestination): string | null =>
  destination.lastDeliveryStatus ? ATTENTION_LABELS[destination.lastDeliveryStatus] ?? null : null
