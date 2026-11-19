import { radiosoRequest } from '../lib/client.js'

const addDocument = async (z, bundle) => {
  const input = bundle.inputData
  const request = { title: input.title, content: input.content }
  if (input.external_document_id) request.externalDocumentId = input.external_document_id

  const body = await radiosoRequest(z, bundle, { method: 'POST', path: '/document', body: request })
  return { id: body.documentId, document_id: body.documentId, status: body.status }
}

export default {
  key: 'add_document',
  noun: 'Document',
  display: {
    label: 'Add a Document',
    description:
      'Adds a text document to the workspace knowledge. Radioso processes it in the background, so a new document is not ready when this step finishes; check Processing status. Sending an External ID that already exists replaces that document, and unchanged content comes back ready at once.',
  },
  operation: {
    inputFields: [
      { key: 'title', label: 'Title', required: true },
      { key: 'content', label: 'Content', type: 'text', required: true, helpText: 'The document text.' },
      {
        key: 'external_document_id',
        label: 'External ID',
        required: false,
        helpText:
          'An ID from your own system, such as a record ID. Sending the same ID again replaces the document it created, so a Zap can keep one document in sync with a record.',
      },
    ],
    perform: addDocument,
    sample: {
      id: '3b9f2c1a-6d4e-4a8b-8c21-5e7d9a0b1c34',
      document_id: '3b9f2c1a-6d4e-4a8b-8c21-5e7d9a0b1c34',
      status: 'pending',
    },
    outputFields: [
      { key: 'document_id', label: 'Document ID' },
      { key: 'status', label: 'Processing status' },
    ],
  },
}
