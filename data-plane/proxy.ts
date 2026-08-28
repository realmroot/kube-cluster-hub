import type {
  AgentPrincipal,
  Cluster,
  UserPrincipal,
} from '../control-plane/domain'
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
  principal: AgentPrincipal,
  requestId: string,
  dependencies: ProxyDependencies,
): Promise<Response> {
  return proxyRequest(
    request,
    cluster,
    principal.token,
    requestId,
    dependencies,
    '/api/agent',
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
  }
  if (body !== undefined) init.duplex = 'half'

  try {
    const response = await dependencies.fetch(
      new Request(`${cluster.apiServerUrl}${targetUri}`, init),
    )
    if (response.status === 101) return response
    const responseHeaders = new Headers(response.headers)
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

export function sanitizedHeaders(input: Headers): Headers {
  const headers = new Headers(input)
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase()
    if (
      lower === 'host' ||
      lower === 'cookie' ||
      lower === 'dpop' ||
      lower === 'authorization' ||
      lower === 'proxy-authorization' ||
      lower === 'x-cluster-authorization' ||
      lower === 'impersonate-user' ||
      lower === 'impersonate-group' ||
      lower.startsWith('impersonate-extra-')
    )
      headers.delete(name)
  }
  return headers
}
