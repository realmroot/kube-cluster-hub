import { type CryptoKey, importJWK, type JWTPayload, SignJWT } from 'jose'
import type { Config } from './config'
import {
  type AgentPrincipal,
  type Cluster,
  type UserPrincipal,
  ValidationError,
} from './domain'

interface DispatchBase extends JWTPayload {
  cluster_id: string
  method: string
  uri: string
  request_id: string
}

interface UserDispatch extends DispatchBase {
  principal_type: 'user'
  user_subject: string
  credential_hash: string
}

interface AgentDispatch extends DispatchBase {
  principal_type: 'agent'
  controller_subject: string
  agent_issuer: string
  agent_subject: string
  scopes: string
}

interface SystemDispatch extends DispatchBase {
  principal_type: 'system'
  system_scope: 'cluster-inventory:write'
}

export type DispatchClaims = UserDispatch | AgentDispatch | SystemDispatch

export class DispatchSigner {
  private constructor(
    private readonly config: Pick<
      Config,
      'dispatchIssuer' | 'dispatchAudience'
    >,
    private readonly key: CryptoKey,
    private readonly keyId: string,
  ) {}

  static async create(config: Config): Promise<DispatchSigner> {
    const key = await importJWK(config.dispatchPrivateJwk, 'ES256')
    if (!(key instanceof CryptoKey))
      throw new Error('dispatch JWK did not produce a CryptoKey')
    return new DispatchSigner(
      config,
      key,
      config.dispatchPrivateJwk.kid as string,
    )
  }

  async forUser(
    clusterId: string,
    method: string,
    uri: string,
    requestId: string,
    principal: UserPrincipal,
  ): Promise<string> {
    return this.sign({
      cluster_id: clusterId,
      method,
      uri,
      request_id: requestId,
      principal_type: 'user',
      user_subject: principal.subject,
      credential_hash: await sha256Base64Url(principal.token),
    })
  }

  async forAgent(
    clusterId: string,
    method: string,
    uri: string,
    requestId: string,
    principal: AgentPrincipal,
  ): Promise<string> {
    return this.sign({
      cluster_id: clusterId,
      method,
      uri,
      request_id: requestId,
      principal_type: 'agent',
      controller_subject: principal.controllerSubject,
      agent_issuer: principal.actor.issuer,
      agent_subject: principal.actor.subject,
      scopes: principal.scope,
    })
  }

  async forInventory(
    clusterId: string,
    method: string,
    uri: string,
    requestId: string,
  ): Promise<string> {
    return this.sign({
      cluster_id: clusterId,
      method,
      uri,
      request_id: requestId,
      principal_type: 'system',
      system_scope: 'cluster-inventory:write',
    })
  }

  private async sign(claims: DispatchClaims): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({
        alg: 'ES256',
        typ: 'cag-dispatch+jwt',
        kid: this.keyId,
      })
      .setIssuer(this.config.dispatchIssuer)
      .setAudience(this.config.dispatchAudience)
      .setIssuedAt()
      .setExpirationTime('30s')
      .setJti(crypto.randomUUID())
      .sign(this.key)
  }
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  )
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface ProxyDependencies {
  signer: DispatchSigner
  fetch: typeof globalThis.fetch
}

export class ProxyError extends Error {
  constructor(
    message: string,
    readonly status: 502 | 503 = 502,
  ) {
    super(message)
  }
}

export async function proxyUserRequest(
  request: Request,
  cluster: Cluster,
  principal: UserPrincipal,
  requestId: string,
  dependencies: ProxyDependencies,
): Promise<Response> {
  const targetUri = kubernetesUri(request, cluster.id)
  if (cluster.accessMode === 'direct') {
    return forward(
      request,
      `${cluster.apiServerUrl}${targetUri}`,
      principal.token,
      undefined,
      dependencies.fetch,
    )
  }
  const dispatch = await dependencies.signer.forUser(
    cluster.id,
    request.method,
    targetUri,
    requestId,
    principal,
  )
  return forward(
    request,
    `${cluster.connectorUrl}/clusters/${encodeURIComponent(cluster.id)}/kubernetes${targetUri}`,
    principal.token,
    dispatch,
    dependencies.fetch,
  )
}

export async function proxyAgentRequest(
  request: Request,
  cluster: Cluster,
  principal: AgentPrincipal,
  requestId: string,
  dependencies: ProxyDependencies,
): Promise<Response> {
  if (cluster.accessMode !== 'connector')
    throw new ProxyError('Agent access requires connector mode', 503)
  const targetUri = kubernetesUri(request, cluster.id, '/api/agent')
  const dispatch = await dependencies.signer.forAgent(
    cluster.id,
    request.method,
    targetUri,
    requestId,
    principal,
  )
  return forward(
    request,
    `${cluster.connectorUrl}/clusters/${encodeURIComponent(cluster.id)}/kubernetes${targetUri}`,
    undefined,
    dispatch,
    dependencies.fetch,
  )
}

export async function proxyInventoryRequest(
  cluster: Cluster,
  method: string,
  uri: string,
  requestId: string,
  body: string | undefined,
  dependencies: ProxyDependencies,
): Promise<Response> {
  if (cluster.accessMode !== 'connector')
    throw new Error('inventory cluster requires connector mode')
  const dispatch = await dependencies.signer.forInventory(
    cluster.id,
    method,
    uri,
    requestId,
  )
  const headers = new Headers({
    Authorization: `Bearer ${dispatch}`,
    'Request-Id': requestId,
  })
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  return dependencies.fetch(
    new Request(
      `${cluster.connectorUrl}/clusters/${encodeURIComponent(cluster.id)}/kubernetes${uri}`,
      {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
      },
    ),
  )
}

function kubernetesUri(
  request: Request,
  clusterId: string,
  prefix = '',
): string {
  const url = new URL(request.url)
  const routePrefix = `${prefix}/clusters/${clusterId}/kubernetes`
  if (
    url.pathname !== routePrefix &&
    !url.pathname.startsWith(`${routePrefix}/`)
  ) {
    throw new Error('Kubernetes proxy route is invalid')
  }
  const suffix = url.pathname.slice(routePrefix.length) || '/'
  let decoded: string
  try {
    decoded = decodeURIComponent(suffix)
  } catch {
    throw new ValidationError('Kubernetes proxy path is malformed')
  }
  if (
    !decoded.startsWith('/') ||
    ['\\', '?', '#'].some((character) => decoded.includes(character)) ||
    Array.from(decoded).some((character) => character.charCodeAt(0) < 32) ||
    decoded.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new ValidationError('Kubernetes proxy path is invalid')
  }
  return `${decoded}${url.search}`
}

async function forward(
  request: Request,
  target: string,
  userToken: string | undefined,
  dispatchToken: string | undefined,
  fetcher: typeof globalThis.fetch,
): Promise<Response> {
  const headers = sanitizedHeaders(request.headers)
  // Fetch runtimes transparently decode compressed response bodies while
  // retaining Content-Encoding. Returning that response through another HTTP
  // server makes the downstream client attempt to decode an already decoded
  // body. Request identity encoding at this proxy boundary so body bytes and
  // representation headers always describe the same payload.
  headers.set('Accept-Encoding', 'identity')
  if (dispatchToken) {
    headers.set('Authorization', `Bearer ${dispatchToken}`)
    if (userToken) headers.set('X-Cluster-Authorization', `Bearer ${userToken}`)
  } else if (userToken) {
    headers.set('Authorization', `Bearer ${userToken}`)
  }
  const body = ['GET', 'HEAD'].includes(request.method)
    ? undefined
    : request.body
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body }),
    redirect: 'manual',
  }
  if (body !== undefined) init.duplex = 'half'
  const outgoing = new Request(target, init)
  try {
    return await fetcher(outgoing)
  } catch (error) {
    throw new ProxyError(
      error instanceof Error ? error.message : 'upstream request failed',
    )
  }
}

export function sanitizedHeaders(input: Headers): Headers {
  const headers = new Headers(input)
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase()
    if (
      lower === 'host' ||
      lower === 'cookie' ||
      lower === 'dpop' ||
      lower === 'authorization' ||
      lower === 'x-cluster-authorization' ||
      lower === 'impersonate-user' ||
      lower === 'impersonate-group' ||
      lower.startsWith('impersonate-extra-')
    ) {
      headers.delete(name)
    }
  }
  return headers
}
