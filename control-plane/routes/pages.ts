import { ValidationError } from '../domain'
import type { HubContext } from '../http'
import type { Store } from '../store'

export async function clusterPage(
  context: HubContext,
  store: Store,
  canonicalUrl: string,
): Promise<Response> {
  const pageSize = pageSizeFrom(context)
  const after = context.req.query('pageToken') || ''
  const rows = await store.listClusters(after, pageSize + 1)
  const items = rows.slice(0, pageSize)
  const nextPageToken = rows.length > pageSize ? items.at(-1)?.id : undefined
  if (nextPageToken)
    setNextLink(context, canonicalUrl, {
      pageSize: String(pageSize),
      pageToken: nextPageToken,
    })
  return context.json({
    items,
    pagination: { pageSize, ...(nextPageToken ? { nextPageToken } : {}) },
  })
}

export async function auditPage(
  context: HubContext,
  store: Store,
  canonicalUrl: string,
): Promise<Response> {
  const pageSize = pageSizeFrom(context)
  const rawToken = context.req.query('pageToken')
  const beforeId = rawToken === undefined ? undefined : Number(rawToken)
  if (
    beforeId !== undefined &&
    (!Number.isSafeInteger(beforeId) || beforeId <= 0)
  )
    throw new ValidationError('pageToken is invalid')
  const rows = await store.listAuditEvents(beforeId, pageSize + 1)
  const items = rows.slice(0, pageSize)
  const nextPageToken =
    rows.length > pageSize ? String(items.at(-1)?.id) : undefined
  if (nextPageToken)
    setNextLink(context, canonicalUrl, {
      pageSize: String(pageSize),
      pageToken: nextPageToken,
    })
  return context.json({
    items,
    pagination: { pageSize, ...(nextPageToken ? { nextPageToken } : {}) },
  })
}

function pageSizeFrom(context: HubContext): number {
  const raw = context.req.query('pageSize')
  if (!raw) return 50
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 200)
    throw new ValidationError('pageSize must be between 1 and 200')
  return value
}

function setNextLink(
  context: HubContext,
  canonicalUrl: string,
  query: Record<string, string>,
): void {
  const url = new URL(canonicalUrl)
  for (const [name, value] of Object.entries(query))
    url.searchParams.set(name, value)
  context.header('Link', `<${url}>; rel="next"`)
}
