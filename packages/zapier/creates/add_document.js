'use strict'

const { radiosoRequest } = require('../lib/client')

const addDocument = async (z, bundle) => {
  const input = bundle.inputData
  const request = { title: input.title, content: input.content }
  if (input.external_document_id) request.externalDocumentId = input.external_document_id

  const body = await radiosoRequest(z, bundle, { method: 'POST', path: '/document', body: request })
  return { id: body.documentId, document_id: body.documentId, status: body.status }
}

module.exports = {
  key: 'add_document',
  noun: 'Document',
  display: {
    label: 'Add a Document',
    description:
      'Adds a text document to the workspace knowledge. Radioso accepts it at once and processes it in the background, so the status is not "ready" when this step finishes.',
  },
  operation: {
    inputFields: [
      { key: 'title', label: 'Title', required: true },
      { key: 'content', label: 'Content', type: 'text', required: true, helpText: 'The document text.' },
      {
        key: 'external_document_id',
        label: 'External ID',
        required: false,
        helpText: 'An ID from your own system that identifies this document, such as a record ID.',
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
