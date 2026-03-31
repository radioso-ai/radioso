export const getSafeDocumentsPage = ({
  currentPage,
  totalDocuments,
  pageSize,
  hasLoadedDocuments,
}: {
  currentPage: number
  totalDocuments: number
  pageSize: number
  hasLoadedDocuments: boolean
}) => {
  if (!hasLoadedDocuments) {
    return currentPage
  }

  const totalPages = Math.max(1, Math.ceil(totalDocuments / pageSize))
  return Math.min(currentPage, totalPages)
}
