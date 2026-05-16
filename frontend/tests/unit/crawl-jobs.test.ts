import { describe, expect, it } from 'vitest'

import type { WebsiteCrawlJobStatus, WebsiteCrawlJobSummary } from '@/lib/api'
import { applySourceResumeResult, getCrawlPageIssueSummaries, mergeCrawlJobs, parseCrawlForm } from '@/lib/crawl-jobs'

const baseJob = (overrides: Partial<WebsiteCrawlJobSummary>): WebsiteCrawlJobSummary => ({
  id: 'j-1',
  requestedUrl: 'https://example.com',
  status: 'queued',
  limit: 10,
  sourceId: null,
  documentCount: null,
  failedPageCount: null,
  skippedPageCount: null,
  failures: [],
  lastError: null,
  createdAt: '2026-05-11T10:00:00.000Z',
  updatedAt: '2026-05-11T10:00:00.000Z',
  completedAt: null,
  ...overrides,
})

describe('parseCrawlForm', () => {
  it('rejects an empty url', () => {
    expect(parseCrawlForm({ url: '   ', limit: '', maxLimit: 100 })).toEqual({
      ok: false,
      error: 'Enter a website URL to crawl.',
    })
  })

  it('rejects malformed urls', () => {
    expect(parseCrawlForm({ url: 'not a url', limit: '', maxLimit: 100 })).toEqual({
      ok: false,
      error: 'Enter a valid URL.',
    })
  })

  it('rejects non-http(s) protocols', () => {
    expect(parseCrawlForm({ url: 'file:///etc/passwd', limit: '', maxLimit: 100 })).toEqual({
      ok: false,
      error: 'URL must use http or https.',
    })
  })

  it('returns the trimmed url with no limit when limit is blank', () => {
    expect(parseCrawlForm({ url: '  https://example.com  ', limit: '', maxLimit: 100 })).toEqual({
      ok: true,
      url: 'https://example.com',
      includeUrlPatterns: [],
      excludeUrlPatterns: [],
      preserveContentLinks: true,
    })
  })

  it('rejects non-positive or non-integer limits', () => {
    expect(parseCrawlForm({ url: 'https://example.com', limit: '0', maxLimit: 100 })).toMatchObject({
      ok: false,
    })
    expect(parseCrawlForm({ url: 'https://example.com', limit: '-5', maxLimit: 100 })).toMatchObject({
      ok: false,
    })
    expect(parseCrawlForm({ url: 'https://example.com', limit: '3.5', maxLimit: 100 })).toMatchObject({
      ok: false,
    })
    expect(parseCrawlForm({ url: 'https://example.com', limit: 'abc', maxLimit: 100 })).toMatchObject({
      ok: false,
    })
  })

  it('caps the limit at the configured maximum', () => {
    expect(parseCrawlForm({ url: 'https://example.com', limit: '999', maxLimit: 100 })).toEqual({
      ok: true,
      url: 'https://example.com',
      limit: 100,
      includeUrlPatterns: [],
      excludeUrlPatterns: [],
      preserveContentLinks: true,
    })
  })

  it('passes a valid limit through unchanged', () => {
    expect(parseCrawlForm({ url: 'https://example.com', limit: '7', maxLimit: 100 })).toEqual({
      ok: true,
      url: 'https://example.com',
      limit: 7,
      includeUrlPatterns: [],
      excludeUrlPatterns: [],
      preserveContentLinks: true,
    })
  })

  it('parses crawler policy fields', () => {
    expect(parseCrawlForm({
      url: 'https://example.com',
      limit: '',
      maxLimit: 100,
      includeUrlPatterns: ' /docs/ \n/docs/\n/blog',
      excludeUrlPatterns: '/tag\n/search',
      preserveContentLinks: false,
    })).toEqual({
      ok: true,
      url: 'https://example.com',
      includeUrlPatterns: ['/docs/', '/blog'],
      excludeUrlPatterns: ['/tag', '/search'],
      preserveContentLinks: false,
    })
  })
})

describe('mergeCrawlJobs', () => {
  it('replaces matching jobs from the server payload while preserving optimistic-only entries', () => {
    const optimistic = baseJob({ id: 'optimistic-1', status: 'queued' })
    const incoming = baseJob({ id: 'j-1', status: 'processing' })

    const result = mergeCrawlJobs({
      current: [optimistic],
      incoming: [incoming],
      previousStatuses: new Map(),
    })

    expect(result.jobs.map((job) => job.id)).toEqual(['j-1', 'optimistic-1'])
    expect(result.completedJobIds).toEqual([])
    expect(result.nextStatuses.get('j-1')).toBe('processing')
  })

  it('reports completed transitions only on the first poll observing them', () => {
    const previous = new Map<string, WebsiteCrawlJobStatus>([
      ['j-1', 'processing'],
      ['j-2', 'completed'],
    ])
    const incoming = [
      baseJob({ id: 'j-1', status: 'completed' }),
      baseJob({ id: 'j-2', status: 'completed' }),
    ]

    const first = mergeCrawlJobs({ current: [], incoming, previousStatuses: previous })
    expect(first.completedJobIds).toEqual(['j-1'])

    const second = mergeCrawlJobs({
      current: first.jobs,
      incoming,
      previousStatuses: first.nextStatuses,
    })
    expect(second.completedJobIds).toEqual([])
  })

  it('does not report a completion when the job first appears as completed', () => {
    const incoming = [baseJob({ id: 'j-1', status: 'completed' })]

    const result = mergeCrawlJobs({
      current: [],
      incoming,
      previousStatuses: new Map(),
    })

    expect(result.completedJobIds).toEqual([])
    expect(result.nextStatuses.get('j-1')).toBe('completed')
  })

  it('filters out recently-deleted jobs from the incoming server payload until the server reflects the deletion', () => {
    const stillReturned = baseJob({ id: 'j-1', status: 'completed' })

    const result = mergeCrawlJobs({
      current: [],
      incoming: [stillReturned],
      previousStatuses: new Map(),
      recentlyDeletedJobIds: new Set(['j-1']),
    })

    expect(result.jobs).toEqual([])
    expect(result.completedJobIds).toEqual([])
    expect(result.deletedJobIdsToForget).toEqual([])
  })

  it('signals that recently-deleted ids can be forgotten once the server stops returning them', () => {
    const result = mergeCrawlJobs({
      current: [],
      incoming: [baseJob({ id: 'j-2', status: 'completed' })],
      previousStatuses: new Map(),
      recentlyDeletedJobIds: new Set(['j-1']),
    })

    expect(result.deletedJobIdsToForget).toEqual(['j-1'])
  })

  it('drops optimistic entries once the server returns them by id', () => {
    const optimistic = baseJob({ id: 'j-1', status: 'queued', limit: 5 })
    const real = baseJob({ id: 'j-1', status: 'processing', limit: 5 })

    const result = mergeCrawlJobs({
      current: [optimistic],
      incoming: [real],
      previousStatuses: new Map([['j-1', 'queued']]),
    })

    expect(result.jobs).toEqual([real])
    expect(result.completedJobIds).toEqual([])
  })
})

describe('getCrawlPageIssueSummaries', () => {
  it('labels failed and skipped crawl pages separately', () => {
    expect(getCrawlPageIssueSummaries(baseJob({
      failedPageCount: 2,
      skippedPageCount: 3,
    }))).toEqual([
      { kind: 'failed', label: '2 failed during crawl' },
      { kind: 'skipped', label: '3 skipped during crawl' },
    ])
  })

  it('omits zero and null page issue counts', () => {
    expect(getCrawlPageIssueSummaries(baseJob({
      failedPageCount: 0,
      skippedPageCount: null,
    }))).toEqual([])
  })
})

describe('applySourceResumeResult', () => {
  it('keeps a paused source paused when the backend did not resume any job', () => {
    const result = applySourceResumeResult({
      sourceId: 'source-1',
      resumedJobCount: 0,
      pausedSourceIds: new Set(['source-1']),
      crawlingSourceIds: new Set<string>(),
    })

    expect([...result.pausedSourceIds]).toEqual(['source-1'])
    expect([...result.crawlingSourceIds]).toEqual([])
  })

  it('moves the source from paused to crawling after a job is resumed', () => {
    const result = applySourceResumeResult({
      sourceId: 'source-1',
      resumedJobCount: 1,
      pausedSourceIds: new Set(['source-1']),
      crawlingSourceIds: new Set<string>(),
    })

    expect([...result.pausedSourceIds]).toEqual([])
    expect([...result.crawlingSourceIds]).toEqual(['source-1'])
  })
})
