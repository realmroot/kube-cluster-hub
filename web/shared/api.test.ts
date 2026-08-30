import { afterEach, describe, expect, it, vi } from 'vitest'
import { HubApi } from './api'
import type { UiConfig } from './contracts'

const config: UiConfig = {
  issuer: 'https://identity.example.test',
  clientId: 'kubernetes-client',
  resource: 'https://hub.example.test/api',
  scopes: ['openid', 'clusters:read'],
  apiVersion: '2026-08-29',
}

describe('HubApi', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends the access token, API version, and pagination cursor', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json({ items: [], pagination: { pageSize: 50 } }),
      )
    vi.stubGlobal('fetch', fetcher)
    const api = new HubApi(config, 'access-token')
    await api.listClusters('next-cluster')

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'https://hub.example.test/api/clusters?pageSize=50&pageToken=next-cluster',
    )
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer access-token',
      'API-Version': '2026-08-29',
    })
  })

  it('uses conditional writes and surfaces problem details', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { detail: 'the current ETag is required' },
          { status: 412 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetcher)
    const api = new HubApi(config, 'access-token')
    const cluster = {
      id: 'local-kind',
      displayName: 'Local kind',
      description: '',
      apiServerUrl: 'https://kubernetes.example.test',
      prometheusUrl: '',
      enabled: true,
      default: true,
      resourceVersion: 7,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
    }

    await expect(
      api.saveCluster(cluster.id, cluster, cluster.resourceVersion),
    ).rejects.toThrow('the current ETag is required')
    await api.deleteCluster(cluster)
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'PUT',
      headers: expect.objectContaining({ 'If-Match': '"7"' }),
    })
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: 'DELETE',
      headers: expect.objectContaining({ 'If-Match': '"7"' }),
    })
  })
})
