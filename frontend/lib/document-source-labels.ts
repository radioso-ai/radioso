import type { DocumentSourceListItem } from './api-types'

/** The source kind as the Sources list names it. */
export const formatSourceKind = (kind: DocumentSourceListItem['kind']) => {
  switch (kind) {
    case 'website':
      return 'Website'
    case 'upload':
      return 'Uploads'
    case 'api':
      return 'API'
    case 'connector':
      return 'Connector'
    default:
      return kind
  }
}
