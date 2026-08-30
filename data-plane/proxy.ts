import type { Cluster, UserPrincipal } from '../control-plane/domain'
import { ValidationError } from '../control-plane/domain'

export interface ProxyDependencies {
  fetch: typeof globalThis.fetch
}

export class ProxyError extends Error {
  constructor(
    message: string,
    readonly status: 502 | 503 = 502,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export function proxyUserRequest(
  request: Request,
  cluster: Cluster,
  principal: UserPrincipal,
  requestId: string,
  dependencies: ProxyDependencies,
): Promise<Response> {
  return proxyRequest(
    request,
    cluster,
    principal.token,
    requestId,
    dependencies,
  )
}

export function proxyAgentRequest(
  request: Request,
  cluster: Cluster,
  kubernetesToken: string,
  requestId: string,
  dependencies: ProxyDependencies,
): Promise<Response> {
  return proxyRequest(
    request,
    cluster,
    kubernetesToken,
    requestId,
    dependencies,
    '/api',
  )
}

async function proxyRequest(
  request: Request,
  cluster: Cluster,
  token: string,
  requestId: string,
  dependencies: ProxyDependencies,
  routePrefix = '',
): Promise<Response> {
  const targetUri = kubernetesUri(request, cluster.id, routePrefix)
  const headers = sanitizedHeaders(request.headers)
  headers.set('Accept-Encoding', 'identity')
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('Request-Id', requestId)

  const body = ['GET', 'HEAD'].includes(request.method)
    ? undefined
    : request.body
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body }),
    redirect: 'manual',
    signal: request.signal,
  }
  if (body !== undefined) init.duplex = 'half'

  try {
    const response = await dependencies.fetch(
      new Request(`${cluster.apiServerUrl}${targetUri}`, init),
    )
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      console.info(
        JSON.stringify({
          message: 'kubernetes.websocket.upstream',
          requestId,
          status: response.status,
          hasWebSocket: Boolean(
            (response as Response & { webSocket?: WebSocket }).webSocket,
          ),
          protocol: response.headers.get('Sec-WebSocket-Protocol') || '',
        }),
      )
    }
    if (response.status === 101) return response
    const responseHeaders = sanitizedResponseHeaders(response.headers)
    responseHeaders.set('Cache-Control', 'no-store, no-transform')
    const body = response.body?.pipeThrough(new TransformStream()) || null
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  } catch (cause) {
    throw new ProxyError('Kubernetes API request failed', 502, { cause })
  }
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
  )
    throw new Error('Kubernetes proxy route is invalid')

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
  )
    throw new ValidationError('Kubernetes proxy path is invalid')

  return `${decoded}${url.search}`
}

export function sanitizedHeaders(
  input: Headers,
  options: { upgrade?: boolean } = {},
): Headers {
  const headers = new Headers(input)
  const connectionTokens = connectionHeaderTokens(headers)
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase()
    if (
      lower === 'host' ||
      lower === 'cookie' ||
      lower === 'dpop' ||
      lower === 'authorization' ||
      lower === 'proxy-authorization' ||
      (!options.upgrade &&
        (hopByHopHeaders.has(lower) || connectionTokens.has(lower))) ||
      lower === 'x-cluster-authorization' ||
      lower === 'impersonate-user' ||
      lower === 'impersonate-group' ||
      lower.startsWith('impersonate-extra-')
    )
      headers.delete(name)
  }
  return headers
}

function sanitizedResponseHeaders(input: Headers): Headers {
  const headers = new Headers(input)
  const connectionTokens = connectionHeaderTokens(headers)
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase()
    if (hopByHopHeaders.has(lower) || connectionTokens.has(lower))
      headers.delete(name)
  }
  return headers
}

const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function connectionHeaderTokens(headers: Headers): ReadonlySet<string> {
  return new Set(
    (headers.get('Connection') || '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  )
}
