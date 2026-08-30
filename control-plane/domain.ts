export interface Cluster {
  id: string
  displayName: string
  description: string
  apiServerUrl: string
  prometheusUrl: string
  enabled: boolean
  default: boolean
  resourceVersion: number
  createdAt: string
  updatedAt: string
}

export type ClusterInput = Pick<
  Cluster,
  | 'displayName'
  | 'description'
  | 'apiServerUrl'
  | 'prometheusUrl'
  | 'enabled'
  | 'default'
>

export interface UserPrincipal {
  type: 'user'
  subject: string
  scopes: readonly string[]
  token: string
}

export interface AgentPrincipal {
  type: 'agent'
  controllerSubject: string
  actor: {
    issuer: string
    subject: string
  }
  clientId: string
  scopes: readonly string[]
  scope: string
  tokenId: string
  token: string
  expiresAt: number
}

export interface AuditEvent {
  id: number
  createdAt: string
  requestId: string
  tokenId: string
  principalType: 'user' | 'agent'
  controllerSubject: string
  agentIssuer: string
  agentSubject: string
  userSubject: string
  clientId: string
  scopes: string
  clusterId: string
  method: string
  path: string
  status: number
  durationMillis: number
  exchangeStatus: string
  targetAudience: string
}

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class ValidationError extends Error {}

export function validateClusterId(id: string): void {
  if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(id)) {
    throw new ValidationError(
      'cluster id must be a DNS label of at most 63 characters',
    )
  }
}

export function normalizeClusterInput(raw: unknown): ClusterInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ValidationError('request body must be an object')
  const value = raw as Record<string, unknown>
  const displayName = requiredString(value.displayName, 'displayName', 200)
  const apiServerUrl = apiServerUrlFrom(value.apiServerUrl)
  if (
    value.accessMode !== undefined ||
    value.connectorId !== undefined ||
    value.connectorUrl !== undefined
  )
    throw new ValidationError(
      'connector fields are not supported; apiServerUrl must address the Kubernetes API directly',
    )
  if (value.caBundle !== undefined || value.tlsServerName !== undefined) {
    throw new ValidationError(
      'caBundle and tlsServerName are not catalog fields; expose a TLS endpoint trusted by the Hub runtime',
    )
  }
  return {
    displayName,
    description: optionalString(value.description, 'description', 10_000),
    apiServerUrl,
    prometheusUrl: optionalUrl(value.prometheusUrl, 'prometheusUrl'),
    enabled: optionalBoolean(value.enabled, 'enabled', true),
    default: optionalBoolean(value.default, 'default', false),
  }
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  const result = optionalString(value, field, maxLength)
  if (!result) throw new ValidationError(`${field} is required`)
  return result
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string')
    throw new ValidationError(`${field} must be a string`)
  const result = value.trim()
  if (result.length > maxLength)
    throw new ValidationError(`${field} is too long`)
  return result
}

function optionalBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean')
    throw new ValidationError(`${field} must be a boolean`)
  return value
}

function absoluteUrl(
  value: unknown,
  field: string,
  httpsOnly: boolean,
): string {
  const result = requiredString(value, field, 4096)
  let parsed: URL
  try {
    parsed = new URL(result)
  } catch {
    throw new ValidationError(`${field} must be an absolute URL`)
  }
  if (
    (httpsOnly && parsed.protocol !== 'https:') ||
    (!httpsOnly && !['http:', 'https:'].includes(parsed.protocol))
  ) {
    throw new ValidationError(
      `${field} must use ${httpsOnly ? 'https' : 'http or https'}`,
    )
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ValidationError(
      `${field} must not contain credentials, query, or fragment`,
    )
  }
  if (field === 'apiServerUrl' && parsed.pathname !== '/') {
    throw new ValidationError('apiServerUrl must not contain a path')
  }
  return result.replace(/\/$/, '')
}

function optionalUrl(value: unknown, field: string): string {
  if (value === undefined || value === null || value === '') return ''
  return absoluteUrl(value, field, false)
}

function apiServerUrlFrom(value: unknown): string {
  const result = absoluteUrl(value, 'apiServerUrl', false)
  const parsed = new URL(result)
  const loopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]'
  if (parsed.protocol !== 'https:' && !loopback) {
    throw new ValidationError(
      'apiServerUrl must use HTTPS; HTTP is allowed only for loopback development',
    )
  }
  return result
}
