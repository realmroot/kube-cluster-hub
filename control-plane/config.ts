export interface ConfigSource {
  HUB_PUBLIC_URL?: string
  HUB_UI_CLIENT_ID?: string
  OIDC_ISSUER?: string
  KUBERNETES_OIDC_AUDIENCE?: string
  OIDC_GROUPS_CLAIM?: string
  CATALOG_ADMIN_GROUPS?: string
  RESOURCE_SERVER_URL?: string
  RESOURCE_SERVER_ISSUER?: string
  RESOURCE_SERVER_AUTHORIZED_CLIENT_IDS?: string
  RESOURCE_SERVER_JWT_ALGORITHMS?: string
  AUDIT_RETENTION?: string
}

export interface Config {
  publicUrl: string
  catalogUrl: string
  uiClientId: string
  oidcIssuer: string
  oidcAudience: string
  oidcGroupsClaim: string
  catalogAdminGroups: ReadonlySet<string>
  resourceUrl: string
  resourceIssuer: string
  resourceAuthorizedClients: ReadonlySet<string>
  resourceSigningAlgorithms: readonly string[]
  auditRetentionMs: number
}

export function loadConfig(source: ConfigSource): Config {
  const publicUrl = absoluteUrl(
    required(source.HUB_PUBLIC_URL, 'HUB_PUBLIC_URL'),
    'HUB_PUBLIC_URL',
  )
  const resourceUrl = absoluteUrl(
    source.RESOURCE_SERVER_URL || `${publicUrl}/api/agent`,
    'RESOURCE_SERVER_URL',
  )
  const auditRetentionMs = parseDuration(source.AUDIT_RETENTION || '2160h')
  return {
    publicUrl,
    catalogUrl: `${publicUrl}/api/catalog`,
    uiClientId: required(source.HUB_UI_CLIENT_ID, 'HUB_UI_CLIENT_ID'),
    oidcIssuer: absoluteUrl(
      required(source.OIDC_ISSUER, 'OIDC_ISSUER'),
      'OIDC_ISSUER',
    ),
    oidcAudience: required(
      source.KUBERNETES_OIDC_AUDIENCE,
      'KUBERNETES_OIDC_AUDIENCE',
    ),
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
