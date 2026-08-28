import type { JWK } from 'jose'

export interface ConfigSource {
  GATEWAY_PUBLIC_URL?: string
  GATEWAY_INVENTORY_ACCESS_URL?: string
  OIDC_ISSUER?: string
  OIDC_AUDIENCE?: string
  OIDC_GROUPS_CLAIM?: string
  CATALOG_ADMIN_GROUPS?: string
  RESOURCE_SERVER_URL?: string
  RESOURCE_SERVER_ISSUER?: string
  RESOURCE_SERVER_AUTHORIZED_CLIENT_IDS?: string
  RESOURCE_SERVER_JWT_ALGORITHMS?: string
  KUBERNETES_AGENT_READ_GROUP?: string
  KUBERNETES_AGENT_WRITE_GROUP?: string
  DISPATCH_SIGNING_PRIVATE_JWK?: string
  DISPATCH_ISSUER?: string
  DISPATCH_AUDIENCE?: string
  CONNECTOR_STATUS_TOKEN?: string
  INVENTORY_CLUSTER_ID?: string
  AUDIT_RETENTION?: string
}

export interface Config {
  publicUrl: string
  catalogUrl: string
  inventoryAccessUrl: string
  oidcIssuer: string
  oidcAudience: string
  oidcGroupsClaim: string
  catalogAdminGroups: ReadonlySet<string>
  resourceUrl: string
  resourceIssuer: string
  resourceAuthorizedClients: ReadonlySet<string>
  resourceSigningAlgorithms: readonly string[]
  agentReadGroup: string
  agentWriteGroup: string
  dispatchPrivateJwk: JWK
  dispatchIssuer: string
  dispatchAudience: string
  connectorStatusToken: string
  inventoryClusterId: string
  auditRetentionMs: number
}

export function loadConfig(source: ConfigSource): Config {
  const publicUrl = absoluteUrl(
    required(source.GATEWAY_PUBLIC_URL, 'GATEWAY_PUBLIC_URL'),
    'GATEWAY_PUBLIC_URL',
  )
  const resourceUrl = absoluteUrl(
    source.RESOURCE_SERVER_URL || `${publicUrl}/api/agent`,
    'RESOURCE_SERVER_URL',
  )
  const dispatchPrivateJwk = parsePrivateJwk(
    required(
      source.DISPATCH_SIGNING_PRIVATE_JWK,
      'DISPATCH_SIGNING_PRIVATE_JWK',
    ),
  )
  const auditRetentionMs = parseDuration(source.AUDIT_RETENTION || '2160h')
  return {
    publicUrl,
    catalogUrl: `${publicUrl}/api/catalog`,
    inventoryAccessUrl: absoluteUrl(
      source.GATEWAY_INVENTORY_ACCESS_URL || publicUrl,
      'GATEWAY_INVENTORY_ACCESS_URL',
    ),
    oidcIssuer: absoluteUrl(
      required(source.OIDC_ISSUER, 'OIDC_ISSUER'),
      'OIDC_ISSUER',
    ),
    oidcAudience: required(source.OIDC_AUDIENCE, 'OIDC_AUDIENCE'),
    oidcGroupsClaim: source.OIDC_GROUPS_CLAIM?.trim() || 'groups',
    catalogAdminGroups: nonEmptySet(
      source.CATALOG_ADMIN_GROUPS,
      'CATALOG_ADMIN_GROUPS',
    ),
    resourceUrl,
    resourceIssuer: absoluteUrl(
      required(source.RESOURCE_SERVER_ISSUER, 'RESOURCE_SERVER_ISSUER'),
      'RESOURCE_SERVER_ISSUER',
    ),
    resourceAuthorizedClients: nonEmptySet(
      source.RESOURCE_SERVER_AUTHORIZED_CLIENT_IDS,
      'RESOURCE_SERVER_AUTHORIZED_CLIENT_IDS',
    ),
    resourceSigningAlgorithms: commaList(
      source.RESOURCE_SERVER_JWT_ALGORITHMS || 'RS256',
    ),
    agentReadGroup:
      source.KUBERNETES_AGENT_READ_GROUP?.trim() ||
      'cluster-access:agents:read',
    agentWriteGroup:
      source.KUBERNETES_AGENT_WRITE_GROUP?.trim() ||
      'cluster-access:agents:write',
    dispatchPrivateJwk,
    dispatchIssuer: absoluteUrl(
      source.DISPATCH_ISSUER || publicUrl,
      'DISPATCH_ISSUER',
    ),
    dispatchAudience:
      source.DISPATCH_AUDIENCE?.trim() || 'cluster-access-connector',
    connectorStatusToken: required(
      source.CONNECTOR_STATUS_TOKEN,
      'CONNECTOR_STATUS_TOKEN',
    ),
    inventoryClusterId: source.INVENTORY_CLUSTER_ID?.trim() || '',
    auditRetentionMs,
  }
}

function required(value: string | undefined, name: string): string {
  const result = value?.trim()
  if (!result) throw new Error(`${name} is required`)
  return result
}

function absoluteUrl(value: string, name: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`)
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `${name} must be an absolute HTTP(S) URL without credentials, query, or fragment`,
    )
  }
  return value.replace(/\/$/, '')
}

function commaList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function nonEmptySet(
  value: string | undefined,
  name: string,
): ReadonlySet<string> {
  const items = commaList(value || '')
  if (items.length === 0) throw new Error(`${name} is required`)
  return new Set(items)
}

function parsePrivateJwk(value: string): JWK {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('DISPATCH_SIGNING_PRIVATE_JWK must be a JSON JWK')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('dispatch signing JWK is invalid')
  const jwk = parsed as JWK
  if (
    jwk.kty !== 'EC' ||
    jwk.crv !== 'P-256' ||
    typeof jwk.d !== 'string' ||
    !jwk.kid
  ) {
    throw new Error('dispatch signing JWK must be a P-256 private key with kid')
  }
  return jwk
}

function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value.trim())
  if (!match) throw new Error('AUDIT_RETENTION must use ms, s, m, or h')
  const amount = Number(match[1])
  const unit = match[2]
  const multiplier =
    unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000
  const result = amount * multiplier
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new Error('AUDIT_RETENTION must be greater than zero')
  return result
}
