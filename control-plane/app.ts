import type { Context, Next } from 'hono'
import { Hono } from 'hono'
import {
  type AgentVerifier,
  AuthenticationError,
  type UserVerifier,
} from './auth'
import type { Config } from './config'
import {
  agentOpenApi,
  apiVersion,
  catalogOpenApi,
  kubernetesScope,
  scopes,
} from './contracts'
import {
  type ProxyDependencies,
  ProxyError,
  proxyAgentRequest,
  proxyUserRequest,
} from './dispatch'
import {
  type AgentPrincipal,
  ConflictError,
  type ConnectorStatus,
  NotFoundError,
  normalizeClusterInput,
  type UserPrincipal,
  ValidationError,
  validateClusterId,
} from './domain'
import type { InventoryPublisher } from './inventory'
import type { Store } from './store'

interface Variables {
  requestId: string
}

class AuthorizationError extends Error {}

export interface AppDependencies {
  config: Config
  store: Store
  users: Pick<UserVerifier, 'verify'>
  agents: Pick<AgentVerifier, 'verify'>
  proxy: ProxyDependencies
  inventory: Pick<InventoryPublisher, 'publishWithStatus' | 'delete'>
}

export function createApp(
  dependencies: AppDependencies,
): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>()

  app.use('*', async (context, next) => {
    const requestId = crypto.randomUUID()
    context.set('requestId', requestId)
    try {
      await next()
    } finally {
      context.header('Request-Id', requestId)
    }
  })

  app.onError((error, context) => {
    if (error instanceof AuthenticationError) {
      context.header('WWW-Authenticate', `DPoP error="${error.code}"`)
      return problem(context, 401, error.code, 'Unauthorized', error.message)
    }
    if (error instanceof AuthorizationError)
      return problem(context, 403, 'forbidden', 'Forbidden', error.message)
    if (error instanceof ValidationError)
      return problem(
        context,
        400,
        'invalid-request',
        'Invalid request',
        error.message,
      )
    if (error instanceof NotFoundError)
      return problem(context, 404, 'not-found', 'Not found', error.message)
    if (error instanceof ConflictError)
      return problem(
        context,
        412,
        'precondition-failed',
        'Precondition failed',
        error.message,
      )
    if (error instanceof ProxyError) {
      return problem(
        context,
        error.status,
        'upstream-unavailable',
        'Upstream unavailable',
        error.message,
      )
    }
    console.error(
      JSON.stringify({
        message: 'request.unhandled_error',
        requestId: context.get('requestId'),
        path: context.req.path,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return problem(
      context,
      500,
      'internal-error',
      'Internal server error',
      'The request could not be completed',
    )
  })

  app.get('/healthz', (context) => context.body(null, 204))
  app.get('/readyz', async (context) => {
    await dependencies.store.listClusters('', 1)
    return context.body(null, 204)
  })
  app.get('/openapi/catalog.json', (context) =>
    openApi(context, catalogOpenApi(dependencies.config)),
  )
  app.get('/openapi/agent.json', (context) =>
    openApi(context, agentOpenApi(dependencies.config)),
  )
  app.get('/.well-known/oauth-protected-resource/api/agent', (context) =>
    context.json({
      resource: dependencies.config.resourceUrl,
      authorization_servers: [dependencies.config.resourceIssuer],
      scopes_supported: Object.values(scopes),
      dpop_bound_access_tokens_required: true,
      dpop_signing_alg_values_supported: ['ES256'],
    }),
  )
  app.get('/api/agent', (context) => {
    const serviceDescription = `${dependencies.config.publicUrl}/openapi/agent.json`
    context.header(
      'Link',
      `<${serviceDescription}>; rel="service-desc"; type="application/vnd.oai.openapi+json"`,
    )
    return context.json({
      resource: dependencies.config.resourceUrl,
      serviceDescription,
    })
  })

  app.use('/api/catalog/*', catalogVersion)
  app.get('/api/catalog', catalogVersion, async (context) => {
    await dependencies.users.verify(context.req.header('Authorization'))
    const serviceDescription = `${dependencies.config.publicUrl}/openapi/catalog.json`
    context.header(
      'Link',
      `<${serviceDescription}>; rel="service-desc"; type="application/vnd.oai.openapi+json"`,
    )
    return context.json({
      resource: dependencies.config.catalogUrl,
      serviceDescription,
    })
  })
  app.get('/api/catalog/', catalogVersion, async (context) => {
    await dependencies.users.verify(context.req.header('Authorization'))
    const serviceDescription = `${dependencies.config.publicUrl}/openapi/catalog.json`
    context.header(
      'Link',
      `<${serviceDescription}>; rel="service-desc"; type="application/vnd.oai.openapi+json"`,
    )
    return context.json({
      resource: dependencies.config.catalogUrl,
      serviceDescription,
    })
  })

  app.get('/api/catalog/clusters', async (context) => {
    await dependencies.users.verify(context.req.header('Authorization'))
    return clusterPage(
      context,
      dependencies.store,
      `${dependencies.config.catalogUrl}/clusters`,
    )
  })
  app.get('/api/catalog/clusters/:clusterId', async (context) => {
    await dependencies.users.verify(context.req.header('Authorization'))
    const cluster = await dependencies.store.getCluster(
      context.req.param('clusterId'),
    )
    context.header('ETag', etag(cluster.resourceVersion))
    return context.json(cluster)
  })
  app.put('/api/catalog/clusters/:clusterId', async (context) => {
    const user = await dependencies.users.verify(
      context.req.header('Authorization'),
    )
    requireAdmin(user, dependencies.config)
    const id = context.req.param('clusterId')
    validateClusterId(id)
    const input = normalizeClusterInput(await boundedJson(context.req.raw))
    if (input.accessMode === 'connector' && input.connectorId !== id) {
      throw new ValidationError(
        'connectorId must equal the cluster id in one-Connector-per-cluster mode',
      )
    }
    const ifNoneMatch = context.req.header('If-None-Match')
    const ifMatch = context.req.header('If-Match')
    const cluster =
      ifNoneMatch === '*'
        ? await dependencies.store.createCluster(id, input)
        : await dependencies.store.replaceCluster(id, input, parseEtag(ifMatch))
    await dependencies.inventory.publishWithStatus(cluster)
    const published = await dependencies.store.getCluster(id)
    context.header('ETag', etag(published.resourceVersion))
    return context.json(published, ifNoneMatch === '*' ? 201 : 200)
  })
  app.delete('/api/catalog/clusters/:clusterId', async (context) => {
    const user = await dependencies.users.verify(
      context.req.header('Authorization'),
    )
    requireAdmin(user, dependencies.config)
    const id = context.req.param('clusterId')
    await dependencies.inventory.delete(id)
    await dependencies.store.deleteCluster(
      id,
      parseEtag(context.req.header('If-Match')),
    )
    return context.body(null, 204)
  })
  app.get('/api/catalog/audit-events', async (context) => {
    const user = await dependencies.users.verify(
      context.req.header('Authorization'),
    )
    requireAdmin(user, dependencies.config)
    return auditPage(
      context,
      dependencies.store,
      `${dependencies.config.catalogUrl}/audit-events`,
    )
  })
  app.get('/api/catalog/connector-statuses/:connectorId', async (context) => {
    const user = await dependencies.users.verify(
      context.req.header('Authorization'),
    )
    requireAdmin(user, dependencies.config)
    return context.json(
      await dependencies.store.getConnectorStatus(
        context.req.param('connectorId'),
      ),
    )
  })

  app.put('/api/connector-statuses/:connectorId', async (context) => {
    if (
      !(await constantTimeToken(
        context.req.header('Authorization'),
        dependencies.config.connectorStatusToken,
      ))
    ) {
      throw new AuthenticationError(
        'invalid_token',
        'Connector status credential is invalid',
      )
    }
    const connectorId = context.req.param('connectorId')
    validateClusterId(connectorId)
    const status = connectorStatus(
      connectorId,
      await boundedJson(context.req.raw),
    )
    await dependencies.store.putConnectorStatus(status)
    return context.json(status)
  })

  app.all('/clusters/:clusterId/kubernetes', (context) =>
    userProxy(context, dependencies),
  )
  app.all('/clusters/:clusterId/kubernetes/*', (context) =>
    userProxy(context, dependencies),
  )

  app.get('/api/agent/clusters', async (context) => {
    const started = Date.now()
    const agent = await verifyAgent(context, dependencies)
    let status = 403
    try {
      requireScope(agent, scopes.clustersRead)
      const response = await clusterPage(
        context,
        dependencies.store,
        `${dependencies.config.resourceUrl}/clusters`,
      )
      status = response.status
      return response
    } finally {
      await dependencies.store.appendAudit(
        auditForAgent(context, agent, '', status, Date.now() - started),
      )
    }
  })
  app.get('/api/agent/audit-events', async (context) => {
    const started = Date.now()
    const agent = await verifyAgent(context, dependencies)
    let status = 403
    try {
      requireScope(agent, scopes.auditRead)
      const response = await auditPage(
        context,
        dependencies.store,
        `${dependencies.config.resourceUrl}/audit-events`,
      )
      status = response.status
      return response
    } finally {
      await dependencies.store.appendAudit(
        auditForAgent(context, agent, '', status, Date.now() - started),
      )
    }
  })
  app.all('/api/agent/clusters/:clusterId/kubernetes', (context) =>
    agentProxy(context, dependencies),
  )
  app.all('/api/agent/clusters/:clusterId/kubernetes/*', (context) =>
    agentProxy(context, dependencies),
  )

  return app
}

async function userProxy(
  context: Context<{ Variables: Variables }>,
  dependencies: AppDependencies,
): Promise<Response> {
  const started = Date.now()
  const user = await dependencies.users.verify(
    context.req.header('Authorization'),
  )
  const clusterId = requiredClusterId(context)
  let status = 502
  try {
    const cluster = await enabledCluster(dependencies.store, clusterId)
    const response = await proxyUserRequest(
      context.req.raw,
      cluster,
      user,
      requiredRequestId(context),
      dependencies.proxy,
    )
    status = response.status
    return response
  } catch (error) {
    status = auditStatus(error, status)
    throw error
  } finally {
    await dependencies.store.appendAudit(
      auditForUser(context, user, clusterId, status, Date.now() - started),
    )
  }
}

async function agentProxy(
  context: Context<{ Variables: Variables }>,
  dependencies: AppDependencies,
): Promise<Response> {
  const started = Date.now()
  const agent = await verifyAgent(context, dependencies)
  const clusterId = requiredClusterId(context)
  let status = 403
  try {
    requireScope(
      agent,
      kubernetesScope(context.req.method, new URL(context.req.url).pathname),
    )
    const cluster = await enabledCluster(dependencies.store, clusterId)
    status = 502
    const response = await proxyAgentRequest(
      context.req.raw,
      cluster,
      agent,
      requiredRequestId(context),
      dependencies.proxy,
    )
    status = response.status
    return response
  } catch (error) {
    status = auditStatus(error, status)
    throw error
  } finally {
    await dependencies.store.appendAudit(
      auditForAgent(context, agent, clusterId, status, Date.now() - started),
    )
  }
}

async function verifyAgent(
  context: Context<{ Variables: Variables }>,
  dependencies: AppDependencies,
): Promise<AgentPrincipal> {
  const url = new URL(context.req.url)
  const canonical = `${dependencies.config.resourceUrl}${url.pathname.slice('/api/agent'.length)}${url.search}`
  return dependencies.agents.verify(
    context.req.header('Authorization'),
    context.req.header('DPoP'),
    context.req.method,
    canonical,
  )
}

async function enabledCluster(store: Store, id: string) {
  const cluster = await store.getCluster(id)
  if (!cluster.enabled) throw new ProxyError('cluster is disabled', 503)
  return cluster
}

async function clusterPage(
  context: Context<{ Variables: Variables }>,
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

async function auditPage(
  context: Context<{ Variables: Variables }>,
  store: Store,
  canonicalUrl: string,
): Promise<Response> {
  const pageSize = pageSizeFrom(context)
  const rawToken = context.req.query('pageToken')
  const beforeId = rawToken === undefined ? undefined : Number(rawToken)
  if (
    beforeId !== undefined &&
    (!Number.isSafeInteger(beforeId) || beforeId <= 0)
  ) {
    throw new ValidationError('pageToken is invalid')
  }
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

function pageSizeFrom(context: Context): number {
  const raw = context.req.query('pageSize')
  if (!raw) return 50
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 200)
    throw new ValidationError('pageSize must be between 1 and 200')
  return value
}

function setNextLink(
  context: Context,
  canonicalUrl: string,
  query: Record<string, string>,
): void {
  const url = new URL(canonicalUrl)
  for (const [name, value] of Object.entries(query))
    url.searchParams.set(name, value)
  context.header('Link', `<${url}>; rel="next"`)
}

async function catalogVersion(
  context: Context,
  next: Next,
): Promise<Response | undefined> {
  if (context.req.header('API-Version') !== apiVersion) {
    return problem(
      context,
      400,
      'unsupported-api-version',
      'Unsupported API version',
      `API-Version must be ${apiVersion}`,
    )
  }
  context.header('API-Version', apiVersion)
  context.header('Vary', 'API-Version')
  await next()
}

function requireAdmin(user: UserPrincipal, config: Config): void {
  if (!user.groups.some((group) => config.catalogAdminGroups.has(group))) {
    throw new AuthorizationError(
      'catalog administrator group membership is required',
    )
  }
}

function requireScope(agent: AgentPrincipal, scope: string): void {
  if (!agent.scopes.includes(scope))
    throw new AuthorizationError(`${scope} is required`)
}

function etag(version: number): string {
  return `"${version}"`
}

function parseEtag(value: string | undefined): number {
  const match = /^"([1-9]\d*)"$/.exec(value || '')
  if (!match)
    throw new ValidationError('If-Match with the current ETag is required')
  return Number(match[1])
}

async function boundedJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get('Content-Length') || '0')
  if (contentLength > 1_048_576)
    throw new ValidationError('request body exceeds 1 MiB')
  const text = await request.text()
  if (text.length > 1_048_576)
    throw new ValidationError('request body exceeds 1 MiB')
  try {
    return JSON.parse(text)
  } catch {
    throw new ValidationError('request body must be valid JSON')
  }
}

function connectorStatus(connectorId: string, raw: unknown): ConnectorStatus {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ValidationError('status body must be an object')
  const value = raw as Record<string, unknown>
  if (
    value.connectorId !== connectorId ||
    typeof value.clusterId !== 'string' ||
    typeof value.version !== 'string'
  ) {
    throw new ValidationError('connector status identity is invalid')
  }
  validateClusterId(value.clusterId)
  if (value.clusterId !== connectorId)
    throw new ValidationError('connectorId and clusterId must match')
  if (value.state !== 'ready' && value.state !== 'degraded')
    throw new ValidationError('connector state is invalid')
  if (
    !Array.isArray(value.capabilities) ||
    value.capabilities.some((item) => typeof item !== 'string')
  ) {
    throw new ValidationError('connector capabilities are invalid')
  }
  return {
    connectorId,
    clusterId: value.clusterId,
    version: value.version,
    kubernetesVersion:
      typeof value.kubernetesVersion === 'string'
        ? value.kubernetesVersion
        : '',
    capabilities: value.capabilities as string[],
    state: value.state,
    lastError: typeof value.lastError === 'string' ? value.lastError : '',
    observedAt: new Date().toISOString(),
  }
}

async function constantTimeToken(
  authorization: string | undefined,
  expected: string,
): Promise<boolean> {
  const parts = authorization?.trim().split(/\s+/) ?? []
  const provided =
    parts.length === 2 && parts[0]?.toLowerCase() === 'bearer'
      ? parts[1] || ''
      : ''
  const encoder = new TextEncoder()
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  const left = new Uint8Array(providedHash)
  const right = new Uint8Array(expectedHash)
  let difference = 0
  for (let index = 0; index < left.length; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return difference === 0
}

function requiredRequestId(context: Context<{ Variables: Variables }>): string {
  const requestId = context.get('requestId')
  if (!requestId) throw new Error('request id middleware did not run')
  return requestId
}

function requiredClusterId(context: Context<{ Variables: Variables }>): string {
  const clusterId = context.req.param('clusterId')
  if (!clusterId) throw new ValidationError('clusterId is required')
  return clusterId
}

function openApi(context: Context, document: object): Response {
  return context.json(document, 200, {
    'Content-Type': 'application/vnd.oai.openapi+json',
  })
}

function problem(
  context: Context,
  status: 400 | 401 | 403 | 404 | 412 | 500 | 502 | 503,
  type: string,
  title: string,
  detail: string,
): Response {
  return context.json(
    {
      type: `https://cluster-access.io/problems/${type}`,
      title,
      status,
      detail,
      requestId: context.get('requestId'),
    },
    status,
    { 'Content-Type': 'application/problem+json' },
  )
}

function auditForUser(
  context: Context<{ Variables: Variables }>,
  user: UserPrincipal,
  clusterId: string,
  status: number,
  durationMillis: number,
) {
  return {
    requestId: context.get('requestId'),
    tokenId: '',
    principalType: 'user' as const,
    controllerSubject: '',
    agentIssuer: '',
    agentSubject: '',
    userSubject: user.subject,
    clientId: '',
    scopes: '',
    clusterId,
    method: context.req.method,
    path: new URL(context.req.url).pathname,
    status,
    durationMillis,
  }
}

function auditForAgent(
  context: Context<{ Variables: Variables }>,
  agent: AgentPrincipal,
  clusterId: string,
  status: number,
  durationMillis: number,
) {
  return {
    requestId: context.get('requestId'),
    tokenId: agent.tokenId,
    principalType: 'agent' as const,
    controllerSubject: agent.controllerSubject,
    agentIssuer: agent.actor.issuer,
    agentSubject: agent.actor.subject,
    userSubject: '',
    clientId: agent.clientId,
    scopes: agent.scope,
    clusterId,
    method: context.req.method,
    path: new URL(context.req.url).pathname,
    status,
    durationMillis,
  }
}

function auditStatus(error: unknown, fallback: number): number {
  if (error instanceof AuthorizationError) return 403
  if (error instanceof ValidationError) return 400
  if (error instanceof NotFoundError) return 404
  if (error instanceof ConflictError) return 412
  if (error instanceof ProxyError) return error.status
  return fallback
}
