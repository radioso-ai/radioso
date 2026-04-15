#!/usr/bin/env node

import { createReadStream } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const siteRoot = path.resolve(__dirname, '../tests/embed-site')
const port = Number.parseInt(process.env.EMBED_TEST_PORT ?? '4321', 10)
const host = process.env.EMBED_TEST_HOST ?? '0.0.0.0'

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
])

const sendNotFound = (res) => {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Not found')
}

const sendMethodNotAllowed = (res) => {
  res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Method not allowed')
}

const resolvePath = (requestPath) => {
  const normalizedPath = requestPath === '/' ? '/index.html' : requestPath
  const decodedPath = decodeURIComponent(normalizedPath)
  const candidatePath = path.resolve(siteRoot, `.${decodedPath}`)

  if (!candidatePath.startsWith(siteRoot)) {
    return null
  }

  return candidatePath
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendMethodNotAllowed(res)
    return
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const filePath = resolvePath(url.pathname)

  if (!filePath) {
    sendNotFound(res)
    return
  }

  try {
    await access(filePath)
    const fileStat = await stat(filePath)

    if (!fileStat.isFile()) {
      sendNotFound(res)
      return
    }

    const extension = path.extname(filePath)
    const contentType = contentTypes.get(extension) ?? 'application/octet-stream'

    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-length': fileStat.size,
      'content-type': contentType,
    })

    if (req.method === 'HEAD') {
      res.end()
      return
    }

    createReadStream(filePath).pipe(res)
  } catch {
    sendNotFound(res)
  }
})

server.listen(port, host, () => {
  console.log(`Embed test site running at http://127.0.0.1:${port}`)
  console.log(`Blocked-origin variant available at http://localhost:${port}`)
})
