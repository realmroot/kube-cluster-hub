import { once } from 'node:events'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { serve } from '@hono/node-server'
import { exportJWK, generateKeyPair, jwtVerify } from 'jose'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AppDependencies, createApp } from './app'
import { type Config, loadConfig } from './config'
import { apiVersion, kubernetesScope } from './contracts'
import { NodeDatabaseAdapter } from './database-node'
import { DispatchSigner } from './dispatch'
import type { AgentPrincipal, UserPrincipal } from './domain'
import { normalizeClusterInput, ValidationError } from './domain'
import { migrateNodeDatabase } from './migrate-node'
import { Store } from './store'

describe('control plane', () => {
  let database: NodeDatabaseAdapter
  let store: Store
  let config: Config
  let dependencies: AppDependencies
  let forwarded: Request[]
  let publicKey: CryptoKey

  beforeEach(async () => {
    database = new NodeDatabaseAdapter(':memory:')
    migrateNodeDatabase(database)
    store = new Store(database)
    const pair = await generateKeyPair('ES256', { extractable: true })
    publicKey = pair.publicKey
    const privateJwk = await exportJWK(pair.privateKey)
    privateJwk.kid = 'dispatch-test'
    privateJwk.alg = 'ES256'
    const fetcher: typeof fetch = async (request) => {
      forwarded.push(new Request(request))
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"type":"ADDED"}\n'))
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    forwarded = []
    config = loadConfig({
      GATEWAY_PUBLIC_URL: 'https://gateway.example.com',
      OIDC_ISSUER: 'https://identity.example.com',
      OIDC_AUDIENCE: 'kubernetes-client',
      CATALOG_ADMIN_GROUPS: 'platform-admins',
      RESOURCE_SERVER_URL: 'https://gateway.example.com/api/agent',
      RESOURCE_SERVER_ISSUER: 'https://identity.example.com',
      RESOURCE_SERVER_AUTHORIZED_CLIENT_IDS: 'authorized-toolbox-client',
      DISPATCH_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
      CONNECTOR_STATUS_TOKEN: 'connector-status-secret',
    })
    const user: UserPrincipal = {
      type: 'user',
      subject: 'user-1',
      groups: ['platform-admins'],
      token: 'user-id-token',
    }
    const agent: AgentPrincipal = {
      type: 'agent',
      controllerSubject: 'controller-1',
      actor: {
        issuer: config.resourceIssuer,
        subject: 'agent-1',
      },
      clientId: 'authorized-toolbox-client',
      scopes: [
        'clusters:read',
        'kubernetes:read',
        'kubernetes:write',
        'audit-events:read',
      ],
      scope: 'clusters:read kubernetes:read kubernetes:write audit-events:read',
      tokenId: 'token-1',
    }
    const signer = await DispatchSigner.create(config)
    dependencies = {
      config,
      store,
      users: {
        verify: async (authorization) => {
          if (authorization === 'Bearer viewer') return { ...user, groups: [] }
          return user
        },
      },
      agents: { verify: async () => agent },
      proxy: { signer, fetch: fetcher },
      inventory: {
        publishWithStatus: async (cluster) =>
          store.setInventoryPublication(cluster.id, 'ready', ''),
        delete: async () => undefined,
      },
    }
  })

  afterEach(() => database.raw.close())

  it('provides conditional catalog CRUD with admin authorization', async () => {
    const app = createApp(dependencies)
    const created = await app.request('/api/catalog/clusters/development', {
      method: 'PUT',
      headers: catalogHeaders({ 'If-None-Match': '*' }),
      body: JSON.stringify(clusterInput()),
    })
    expect(created.status).toBe(201)
    expect(created.headers.get('ETag')).toBe('"1"')
    expect(created.headers.get('Request-Id')).toBeTruthy()
    expect((await created.json()) as { inventoryStatus: string }).toMatchObject(
      { inventoryStatus: 'ready' },
    )
    await store.createCluster(
      'zeta',
      normalizeClusterInput({ ...clusterInput(), connectorId: 'zeta' }),
    )

    const list = await app.request(
      'http://internal-worker/api/catalog/clusters?pageSize=1',
      {
        headers: catalogHeaders(),
      },
    )
    expect(list.status).toBe(200)
    expect(list.headers.get('Link')).toBe(
      '<https://gateway.example.com/api/catalog/clusters?pageSize=1&pageToken=development>; rel="next"',
    )
    expect(await list.json()).toMatchObject({
      items: [{ id: 'development', accessMode: 'connector' }],
    })

    const denied = await app.request('/api/catalog/clusters/another', {
      method: 'PUT',
      headers: catalogHeaders({
        Authorization: 'Bearer viewer',
        'If-None-Match': '*',
      }),
      body: JSON.stringify(clusterInput()),
    })
    expect(denied.status, await denied.clone().text()).toBe(403)
    expect(denied.headers.get('Content-Type')).toContain(
      'application/problem+json',
    )

    const stale = await app.request('/api/catalog/clusters/development', {
      method: 'PUT',
      headers: catalogHeaders({ 'If-Match': '"99"' }),
      body: JSON.stringify(clusterInput()),
    })
    expect(stale.status).toBe(412)

    const missingVersion = await app.request('/api/catalog/clusters', {
      headers: { Authorization: 'Bearer admin' },
    })
    expect(missingVersion.status).toBe(400)
    expect(missingVersion.headers.get('Request-Id')).toBeTruthy()
  })

  it('signs a request-bound user dispatch and streams the Connector response', async () => {
    await store.createCluster(
      'development',
      normalizeClusterInput(clusterInput()),
    )
    const app = createApp(dependencies)
    const response = await app.request(
      '/clusters/development/kubernetes/api/v1/pods?watch=true',
      {
        headers: { Authorization: 'Bearer user-id-token' },
      },
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"type":"ADDED"}\n')
    expect(forwarded).toHaveLength(1)
    const request = forwarded[0]
    expect(request).toBeDefined()
    if (!request) throw new Error('expected a forwarded request')
    expect(request.url).toBe(
      'http://127.0.0.1:18082/clusters/development/kubernetes/api/v1/pods?watch=true',
    )
    expect(request.headers.get('X-Cluster-Authorization')).toBe(
      'Bearer user-id-token',
    )
    const dispatch =
      request.headers.get('Authorization')?.slice('Bearer '.length) || ''
    const verified = await jwtVerify(dispatch, publicKey, {
      issuer: config.dispatchIssuer,
      audience: config.dispatchAudience,
    })
    expect(verified.payload).toMatchObject({
      cluster_id: 'development',
      method: 'GET',
      uri: '/api/v1/pods?watch=true',
      principal_type: 'user',
      user_subject: 'user-1',
    })
    expect((await store.listAuditEvents(undefined, 10))[0]).toMatchObject({
      principalType: 'user',
      status: 200,
    })
  })

  it('preserves a readable response across the Node proxy compression boundary', async () => {
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
        'Content-Length': compressed.length,
      })
      response.end(compressed)
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const upstreamAddress = upstream.address()
    if (!upstreamAddress || typeof upstreamAddress === 'string')
      throw new Error('expected an upstream TCP address')

    await store.createCluster(
      'compressed',
      normalizeClusterInput({
        ...clusterInput(),
        connectorId: 'compressed',
        connectorUrl: `http://127.0.0.1:${upstreamAddress.port}`,
      }),
    )
    const app = createApp({
      ...dependencies,
      proxy: { ...dependencies.proxy, fetch: globalThis.fetch },
    })
    const gateway = serve({ fetch: app.fetch, port: 0 })
    await once(gateway, 'listening')
    const gatewayAddress = gateway.address()
    if (!gatewayAddress || typeof gatewayAddress === 'string')
      throw new Error('expected a Gateway TCP address')

    try {
      const response = await fetch(
        `http://127.0.0.1:${gatewayAddress.port}/clusters/compressed/kubernetes/api/v1/pods`,
        { headers: { Authorization: 'Bearer user-id-token' } },
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ items: ['large-response'] })
    } finally {
      gateway.close()
      upstream.close()
      await Promise.all([once(gateway, 'close'), once(upstream, 'close')])
    }
  })

  it('signs Agent identity without forwarding the external access token', async () => {
    await store.createCluster(
      'development',
      normalizeClusterInput(clusterInput()),
    )
    const app = createApp(dependencies)
    const response = await app.request(
      '/api/agent/clusters/development/kubernetes/api/v1/namespaces',
      {
        headers: {
          Authorization: 'DPoP external-access-token',
          DPoP: 'proof',
        },
      },
    )
    expect(response.status).toBe(200)
    const request = forwarded[0]
    expect(request).toBeDefined()
    if (!request) throw new Error('expected a forwarded request')
    expect(request.headers.get('X-Cluster-Authorization')).toBeNull()
    expect(request.headers.get('Authorization')).not.toContain(
      'external-access-token',
    )
    const dispatch =
      request.headers.get('Authorization')?.slice('Bearer '.length) || ''
    const verified = await jwtVerify(dispatch, publicKey, {
      issuer: config.dispatchIssuer,
      audience: config.dispatchAudience,
    })
    expect(verified.payload).toMatchObject({
      principal_type: 'agent',
      controller_subject: 'controller-1',
      agent_subject: 'agent-1',
    })
  })

  it('decodes an OpenAPI path parameter without allowing path traversal', async () => {
    await store.createCluster(
      'development',
      normalizeClusterInput(clusterInput()),
    )
    const app = createApp(dependencies)
    const response = await app.request(
      '/api/agent/clusters/development/kubernetes/api%2Fv1%2Fnamespaces',
      { headers: { Authorization: 'DPoP token', DPoP: 'proof' } },
    )
    expect(response.status).toBe(200)
    expect(forwarded[0]?.url).toBe(
      'http://127.0.0.1:18082/clusters/development/kubernetes/api/v1/namespaces',
    )

    const traversal = await app.request(
      '/api/agent/clusters/development/kubernetes/..%2Fsecrets',
      { headers: { Authorization: 'DPoP token', DPoP: 'proof' } },
    )
    expect(traversal.status).toBe(400)
  })

  it('does not advertise a proprietary Agent Skills document', async () => {
    const app = createApp(dependencies)
    const response = await app.request('/.well-known/agent-skills/index.json')
    expect(response.status).toBe(404)
  })

  it('persists Connector status and DPoP replay state', async () => {
    const app = createApp(dependencies)
    const status = await app.request('/api/connector-statuses/development', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer connector-status-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        connectorId: 'development',
        clusterId: 'development',
        version: '0.2.0',
        kubernetesVersion: 'v1.33.1',
        capabilities: ['streaming'],
        state: 'ready',
      }),
    })
    expect(status.status).toBe(200)
    expect(await store.getConnectorStatus('development')).toMatchObject({
      kubernetesVersion: 'v1.33.1',
    })

    const mismatched = await app.request(
      '/api/connector-statuses/development',
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer connector-status-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectorId: 'development',
          clusterId: 'production',
          version: '0.2.0',
          capabilities: [],
          state: 'ready',
        }),
      },
    )
    expect(mismatched.status).toBe(400)

    await store.consumeDpopProof(
      'thumbprint',
      'proof-1',
      new Date(Date.now() + 60_000),
    )
    await expect(
      store.consumeDpopProof(
        'thumbprint',
        'proof-1',
        new Date(Date.now() + 60_000),
      ),
    ).rejects.toThrow('already used')
  })
})

it('classifies Kubernetes streaming subresources by capability rather than HTTP method alone', () => {
  expect(kubernetesScope('GET', '/api/v1/namespaces/default/pods')).toBe(
    'kubernetes:read',
  )
  expect(
    kubernetesScope(
      'GET',
      '/api/v1/namespaces/default/pods/app/log?follow=true',
    ),
  ).toBe('kubernetes:read')
  expect(
    kubernetesScope(
      'GET',
      '/api/v1/namespaces/default/pods/app/exec?command=sh',
    ),
  ).toBe('kubernetes:write')
  expect(
    kubernetesScope('GET', '/api/v1/namespaces/default/pods/app/attach'),
  ).toBe('kubernetes:write')
  expect(
    kubernetesScope('GET', '/api/v1/namespaces/default/pods/app/portforward'),
  ).toBe('kubernetes:write')
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
    description: 'Local kind cluster',
    apiServerUrl: '',
    prometheusUrl: '',
    accessMode: 'connector',
    connectorId: 'development',
    connectorUrl: 'http://127.0.0.1:18082',
    enabled: true,
    default: true,
  }
}

it('rejects legacy TLS catalog fields and unsafe Connector metadata', () => {
  expect(() =>
    normalizeClusterInput({
      ...clusterInput(),
      caBundle: 'legacy-ca',
    }),
  ).toThrow(ValidationError)
  const unsafeConnector = {
    ...clusterInput(),
    connectorUrl: 'http://connector.example.com',
  }
  expect(() => normalizeClusterInput(unsafeConnector)).toThrow('HTTPS')
})
