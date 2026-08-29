import { once } from 'node:events'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { serve } from '@hono/node-server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AppDependencies, createApp } from './app'
import { type Config, loadConfig } from './config'
import { apiVersion, kubernetesScope } from './contracts'
import { NodeDatabaseAdapter } from './database-node'
import type { AgentPrincipal, UserPrincipal } from './domain'
import { normalizeClusterInput, ValidationError } from './domain'
import { migrateNodeDatabase } from './migrate-node'
import { Store } from './store'

describe('combined control plane and data plane', () => {
  let database: NodeDatabaseAdapter
  let store: Store
  let config: Config
  let dependencies: AppDependencies
  let forwarded: Request[]

  beforeEach(() => {
    database = new NodeDatabaseAdapter(':memory:')
    migrateNodeDatabase(database)
    store = new Store(database.orm)
    forwarded = []
    config = loadConfig({
      HUB_PUBLIC_URL: 'https://gateway.example.com',
      HUB_UI_CLIENT_ID: 'kubernetes-client',
      OIDC_ISSUER: 'https://identity.example.com',
      KUBERNETES_OIDC_AUDIENCE: 'kubernetes-client',
      CATALOG_ADMIN_GROUPS: 'platform-admins',
      RESOURCE_SERVER_AUTHORIZED_CLIENT_IDS: 'authorized-toolbox-client',
      TOKEN_EXCHANGE_CLIENT_ID: 'hub-token-exchanger',
      TOKEN_EXCHANGE_CLIENT_SECRET: 'test-secret',
    })
    const user: UserPrincipal = {
      type: 'user',
      subject: 'user-1',
      groups: ['platform-admins'],
      scopes: ['clusters:read', 'clusters:write', 'audit-events:read'],
      token: 'user-id-token',
    }
    const agent: AgentPrincipal = {
      type: 'agent',
      controllerSubject: 'controller-1',
      actor: { issuer: config.oidcIssuer, subject: 'agent-1' },
      clientId: 'authorized-toolbox-client',
      scopes: [
        'clusters:read',
        'kubernetes:read',
        'kubernetes:write',
        'audit-events:read',
      ],
      scope: 'clusters:read kubernetes:read kubernetes:write audit-events:read',
      tokenId: 'token-1',
      token: 'agent-access-token',
      expiresAt: Math.floor(Date.now() / 1_000) + 300,
    }
    dependencies = {
      config,
      store,
      catalogUsers: {
        verify: async (authorization) =>
          authorization === 'Bearer viewer' ? { ...user, groups: [] } : user,
      },
      kubernetesUsers: { verify: async () => user },
      agents: { verify: async () => agent },
      agentTokens: {
        exchange: async () => ({
          token: 'kubernetes-id-token',
          targetAudience: config.oidcAudience,
          groups: ['platform-admins'],
        }),
      },
      proxy: {
        fetch: async (request) => {
          forwarded.push(new Request(request))
          return new Response('{"type":"ADDED"}\n', { status: 200 })
        },
      },
    }
  })

  afterEach(() => database.raw.close())

  it('publishes one Hub Resource Server contract', async () => {
    const app = createApp(dependencies)
    const root = await app.request('/api')
    expect(root.status).toBe(200)
    expect(root.headers.get('Link')).toBe(
      '<https://gateway.example.com/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"',
    )
    expect(await root.json()).toEqual({
      resource: 'https://gateway.example.com/api',
      serviceDescription: 'https://gateway.example.com/openapi.json',
    })

    const metadata = await app.request(
      '/.well-known/oauth-protected-resource/api',
    )
    expect(await metadata.json()).toMatchObject({
      resource: 'https://gateway.example.com/api',
      authorization_servers: ['https://identity.example.com'],
      scopes_supported: [
        'clusters:read',
        'clusters:write',
        'kubernetes:read',
        'kubernetes:write',
        'audit-events:read',
      ],
    })

    const contract = (await (await app.request('/openapi.json')).json()) as {
      servers: { url: string }[]
      paths: Record<string, unknown>
    }
    expect(contract.servers).toEqual([
      { url: 'https://gateway.example.com/api' },
    ])
    expect(Object.keys(contract.paths)).toEqual([
      '/clusters',
      '/clusters/{clusterId}',
      '/audit-events',
      '/clusters/{clusterId}/kubernetes',
      '/clusters/{clusterId}/kubernetes/{kubernetesPath}',
    ])

    expect((await app.request('/api/catalog')).status).toBe(404)
    expect((await app.request('/api/agent')).status).toBe(404)
  })

  it('uses Bearer for human reads and DPoP for Agent reads on one URI', async () => {
    await store.createCluster(
      'development',
      normalizeClusterInput(clusterInput()),
    )
    const app = createApp(dependencies)
    const human = await app.request('/api/clusters', {
      headers: catalogHeaders(),
    })
    expect(human.status).toBe(200)

    const agent = await app.request('/api/clusters', {
      headers: {
        Authorization: 'DPoP agent-token',
        DPoP: 'proof',
        'API-Version': apiVersion,
      },
    })
    expect(agent.status).toBe(200)
    expect(await store.listAuditEvents(undefined, 10)).toEqual([
      expect.objectContaining({
        principalType: 'agent',
        agentSubject: 'agent-1',
        path: '/api/clusters',
        status: 200,
      }),
    ])
  })

  it('provides conditional catalog CRUD with admin authorization', async () => {
    const app = createApp(dependencies)
    const created = await app.request('/api/clusters/development', {
      method: 'PUT',
      headers: catalogHeaders({ 'If-None-Match': '*' }),
      body: JSON.stringify(clusterInput()),
    })
    expect(created.status).toBe(201)
    expect(created.headers.get('ETag')).toBe('"1"')
    expect(await created.json()).toMatchObject({
      id: 'development',
      apiServerUrl: 'https://kubernetes.example.test',
    })
    await store.createCluster(
      'zeta',
      normalizeClusterInput({
        ...clusterInput(),
        apiServerUrl: 'https://zeta.example.test',
      }),
    )
    const list = await app.request(
      'http://internal-worker/api/clusters?pageSize=1',
      { headers: catalogHeaders() },
    )
    expect(list.status).toBe(200)
    expect(list.headers.get('Link')).toBe(
      '<https://gateway.example.com/api/clusters?pageSize=1&pageToken=development>; rel="next"',
    )
    expect(await list.json()).toMatchObject({ items: [{ id: 'development' }] })

    const denied = await app.request('/api/clusters/another', {
      method: 'PUT',
      headers: catalogHeaders({
        Authorization: 'Bearer viewer',
        'If-None-Match': '*',
      }),
      body: JSON.stringify(clusterInput()),
    })
    expect(denied.status).toBe(403)
    expect(denied.headers.get('Content-Type')).toContain(
      'application/problem+json',
    )
    const stale = await app.request('/api/clusters/development', {
      method: 'PUT',
      headers: catalogHeaders({ 'If-Match': '"99"' }),
      body: JSON.stringify(clusterInput()),
    })
    expect(stale.status).toBe(412)
  })

  it('reports a retryable Inventory publication failure after storing the catalog change', async () => {
    dependencies.inventory = {
      publish: async () => {
        throw new Error('inventory unavailable')
      },
      remove: async () => undefined,
      reconcile: async () => undefined,
    }
    const response = await createApp(dependencies).request(
      '/api/clusters/development',
      {
        method: 'PUT',
        headers: catalogHeaders({ 'If-None-Match': '*' }),
        body: JSON.stringify(clusterInput()),
      },
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      type: 'https://kube-cluster-hub.dev/problems/inventory-publication-pending',
      status: 503,
    })
    expect((await store.getCluster('development')).id).toBe('development')
  })

  it('forwards a user token directly to the Kubernetes API', async () => {
    await store.createCluster(
      'development',
      normalizeClusterInput(clusterInput()),
    )
    const response = await createApp(dependencies).request(
      '/clusters/development/kubernetes/api/v1/pods?watch=true',
      { headers: { Authorization: 'Bearer user-id-token' } },
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"type":"ADDED"}\n')
    expect(forwarded[0]?.url).toBe(
      'https://kubernetes.example.test/api/v1/pods?watch=true',
    )
    expect(forwarded[0]?.headers.get('Authorization')).toBe(
      'Bearer user-id-token',
    )
    expect(forwarded[0]?.headers.get('X-Cluster-Authorization')).toBeNull()
    expect((await store.listAuditEvents(undefined, 10))[0]).toMatchObject({
      principalType: 'user',
      status: 200,
    })
  })

  it('exchanges Agent authority before forwarding to Kubernetes', async () => {
    await store.createCluster(
      'development',
      normalizeClusterInput(clusterInput()),
    )
    const response = await createApp(dependencies).request(
      '/api/clusters/development/kubernetes/api/v1/namespaces',
      {
        headers: {
          Authorization: 'DPoP external-token',
          DPoP: 'proof',
          'API-Version': apiVersion,
        },
      },
    )
    expect(response.status).toBe(200)
    expect(forwarded[0]?.url).toBe(
      'https://kubernetes.example.test/api/v1/namespaces',
    )
    expect(forwarded[0]?.headers.get('Authorization')).toBe(
      'Bearer kubernetes-id-token',
    )
    expect(forwarded[0]?.headers.get('DPoP')).toBeNull()
    expect((await store.listAuditEvents(undefined, 10))[0]).toMatchObject({
      exchangeStatus: 'succeeded',
      targetAudience: 'kubernetes-client',
    })
  })

  it('preserves readable responses across the Node compression boundary', async () => {
    const upstream = createServer((request, response) => {
      const body = Buffer.from(JSON.stringify({ items: ['large-response'] }))
      if (request.headers['accept-encoding'] === 'identity') {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        })
        response.end(body)
        return
      }
      const compressed = gzipSync(body)
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      })
      response.end(compressed)
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const address = upstream.address()
    if (!address || typeof address === 'string')
      throw new Error('expected upstream TCP address')
    await store.createCluster(
      'compressed',
      normalizeClusterInput({
        ...clusterInput(),
        apiServerUrl: `http://127.0.0.1:${address.port}`,
      }),
    )
    const gateway = serve({
      fetch: createApp({ ...dependencies, proxy: { fetch: globalThis.fetch } })
        .fetch,
      port: 0,
    })
    await once(gateway, 'listening')
    const gatewayAddress = gateway.address()
    if (!gatewayAddress || typeof gatewayAddress === 'string')
      throw new Error('expected Gateway TCP address')
    try {
      const response = await fetch(
        `http://127.0.0.1:${gatewayAddress.port}/clusters/compressed/kubernetes/api/v1/pods`,
        { headers: { Authorization: 'Bearer user-id-token' } },
      )
      expect(await response.json()).toEqual({ items: ['large-response'] })
    } finally {
      gateway.close()
      upstream.close()
      await Promise.all([once(gateway, 'close'), once(upstream, 'close')])
    }
  })

  it('delivers the first Kubernetes stream chunk before the upstream closes', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.write('{"type":"ADDED"}\n')
      setTimeout(() => response.end('{"type":"BOOKMARK"}\n'), 500)
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const address = upstream.address()
    if (!address || typeof address === 'string')
      throw new Error('expected upstream TCP address')
    await store.createCluster(
      'streaming',
      normalizeClusterInput({
        ...clusterInput(),
        apiServerUrl: `http://127.0.0.1:${address.port}`,
      }),
    )
    const gateway = serve({
      fetch: createApp({ ...dependencies, proxy: { fetch: globalThis.fetch } })
        .fetch,
      port: 0,
    })
    await once(gateway, 'listening')
    const gatewayAddress = gateway.address()
    if (!gatewayAddress || typeof gatewayAddress === 'string')
      throw new Error('expected Gateway TCP address')
    try {
      const response = await fetch(
        `http://127.0.0.1:${gatewayAddress.port}/clusters/streaming/kubernetes/api/v1/pods?watch=true`,
        { headers: { Authorization: 'Bearer user-id-token' } },
      )
      const reader = response.body?.getReader()
      if (!reader) throw new Error('expected streaming response body')
      const first = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('first stream chunk was buffered')),
            250,
          ),
        ),
      ])
      expect(new TextDecoder().decode(first.value)).toBe('{"type":"ADDED"}\n')
      await reader.cancel()
    } finally {
      gateway.close()
      upstream.close()
      await Promise.all([once(gateway, 'close'), once(upstream, 'close')])
    }
  })

  it('decodes Kubernetes paths without allowing traversal', async () => {
    await store.createCluster(
      'development',
      normalizeClusterInput(clusterInput()),
    )
    const app = createApp(dependencies)
    const response = await app.request(
      '/api/clusters/development/kubernetes/api%2Fv1%2Fnamespaces',
      {
        headers: {
          Authorization: 'DPoP token',
          DPoP: 'proof',
          'API-Version': apiVersion,
        },
      },
    )
    expect(response.status).toBe(200)
    expect(forwarded[0]?.url).toBe(
      'https://kubernetes.example.test/api/v1/namespaces',
    )
    const traversal = await app.request(
      '/api/clusters/development/kubernetes/..%2Fsecrets',
      {
        headers: {
          Authorization: 'DPoP token',
          DPoP: 'proof',
          'API-Version': apiVersion,
        },
      },
    )
    expect(traversal.status).toBe(400)
  })

  it('persists DPoP replay state', async () => {
    const expiry = new Date(Date.now() + 60_000)
    await store.consumeDpopProof('thumbprint', 'proof-1', expiry)
    await expect(
      store.consumeDpopProof('thumbprint', 'proof-1', expiry),
    ).rejects.toThrow('already used')
  })
})

it('classifies Kubernetes streaming subresources by capability', () => {
  expect(kubernetesScope('GET', '/api/v1/namespaces/default/pods')).toBe(
    'kubernetes:read',
  )
  expect(
    kubernetesScope(
      'GET',
      '/api/v1/namespaces/default/pods/app/log?follow=true',
    ),
  ).toBe('kubernetes:read')
  for (const subresource of ['exec', 'attach', 'portforward']) {
    expect(
      kubernetesScope(
        'GET',
        `/api/v1/namespaces/default/pods/app/${subresource}`,
      ),
    ).toBe('kubernetes:write')
  }
})

it('rejects obsolete credential and Connector catalog fields', () => {
  expect(() =>
    normalizeClusterInput({ ...clusterInput(), caBundle: 'legacy-ca' }),
  ).toThrow(ValidationError)
  expect(() =>
    normalizeClusterInput({ ...clusterInput(), connectorId: 'legacy' }),
  ).toThrow('connector fields are not supported')
  expect(() =>
    normalizeClusterInput({
      ...clusterInput(),
      apiServerUrl: 'http://kubernetes.example.test',
    }),
  ).toThrow('HTTPS')
})

function catalogHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Authorization: 'Bearer admin',
    'API-Version': apiVersion,
    'Content-Type': 'application/json',
    ...extra,
  }
}

function clusterInput(): object {
  return {
    displayName: 'Development',
    description: 'Test cluster',
    apiServerUrl: 'https://kubernetes.example.test',
    prometheusUrl: '',
    enabled: true,
    default: true,
  }
}
