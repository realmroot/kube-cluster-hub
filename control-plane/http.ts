import type { Context, Next } from 'hono'
import { ProxyError } from '../data-plane/proxy'
import type { Variables } from './app-dependencies'
import { AuthenticationError } from './auth'
import type { Config } from './config'
import { apiVersion } from './contracts'
import {
  type AgentPrincipal,
  ConflictError,
  NotFoundError,
  type UserPrincipal,
  ValidationError,
} from './domain'
import { TokenExchangeError } from './token-exchange'

export type HubContext = Context<{ Variables: Variables }>

class AuthorizationError extends Error {}

export function installHttpBoundary(
  app: import('./app-dependencies').HubApp,
): void {
  app.use('*', async (context, next) => {
    const requestId = crypto.randomUUID()
    const started = Date.now()
    context.set('requestId', requestId)
    try {
      await next()
    } finally {
      context.header('Request-Id', requestId)
      console.info(
        JSON.stringify({
          message: 'request.completed',
          requestId,
          method: context.req.method,
          path: context.req.path,
          status: context.res.status,
          durationMillis: Date.now() - started,
        }),
      )
    }
  })

  app.onError((error, context) => {
    if (error instanceof AuthenticationError) {
      const authorization = context.req.header('Authorization') || ''
      const agentOnly = /^\/api\/clusters\/[^/]+\/kubernetes(?:\/|$)/.test(
        context.req.path,
      )
      const scheme =
        agentOnly || authorization.startsWith('DPoP ') ? 'DPoP' : 'Bearer'
      context.header('WWW-Authenticate', `${scheme} error="${error.code}"`)
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
    if (error instanceof ProxyError)
      return problem(
        context,
        error.status,
        'upstream-unavailable',
        'Upstream unavailable',
        error.message,
      )
    if (error instanceof TokenExchangeError)
      return problem(
        context,
        error.code === 'denied' ? 403 : 502,
        error.code === 'denied'
          ? 'token-exchange-denied'
          : 'token-exchange-unavailable',
        error.code === 'denied'
          ? 'Token exchange denied'
          : 'Token exchange unavailable',
        error.message,
      )
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

  app.notFound(hubNotFound)
}

export function hubNotFound(context: HubContext): Response {
  return problem(
    context,
    404,
    'not-found',
    'Not found',
    'The requested Hub resource does not exist',
  )
}

export async function catalogVersion(
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
  context.header('Cache-Control', 'private, no-store')
  await next()
}

export function requireAdmin(user: UserPrincipal, config: Config): void {
  if (!user.groups.some((group) => config.catalogAdminGroups.has(group)))
    throw new AuthorizationError(
      'catalog administrator group membership is required',
    )
}

export function requireUserScope(user: UserPrincipal, scope: string): void {
  if (!user.scopes.includes(scope))
    throw new AuthorizationError(`${scope} is required`)
}

export function requireAgentScope(agent: AgentPrincipal, scope: string): void {
  if (!agent.scopes.includes(scope))
    throw new AuthorizationError(`${scope} is required`)
}

export function etag(version: number): string {
  return `"${version}"`
}

export function parseEtag(value: string | undefined): number {
  const match = /^"([1-9]\d*)"$/.exec(value || '')
  if (!match)
    throw new ValidationError('If-Match with the current ETag is required')
  return Number(match[1])
}

export async function boundedJson(request: Request): Promise<unknown> {
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

export function requiredRequestId(context: HubContext): string {
  const requestId = context.get('requestId')
  if (!requestId) throw new Error('request id middleware did not run')
  return requestId
}

export function requiredClusterId(context: HubContext): string {
  const clusterId = context.req.param('clusterId')
  if (!clusterId) throw new ValidationError('clusterId is required')
  return clusterId
}

export function openApi(context: Context, document: object): Response {
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
      type: `https://kube-cluster-hub.dev/problems/${type}`,
      title,
      status,
      detail,
      instance: `urn:request:${context.get('requestId')}`,
    },
    status,
    { 'Content-Type': 'application/problem+json' },
  )
}

export function auditStatus(error: unknown, fallback: number): number {
  if (error instanceof AuthorizationError) return 403
  if (error instanceof ValidationError) return 400
  if (error instanceof NotFoundError) return 404
  if (error instanceof ConflictError) return 412
  if (error instanceof ProxyError) return error.status
  if (error instanceof TokenExchangeError)
    return error.code === 'denied' ? 403 : 502
  return fallback
}
