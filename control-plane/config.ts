export const auditRetentionMs = 90 * 24 * 60 * 60 * 1_000

export interface ConfigSource {
  HUB_PUBLIC_URL?: string
  HUB_UI_CLIENT_ID?: string
  OIDC_ISSUER?: string
  TOKEN_EXCHANGE_CLIENT_ID?: string
  TOKEN_EXCHANGE_CLIENT_SECRET?: string
  INVENTORY_ENABLED?: string
  INVENTORY_KUBECONFIG?: string
  INVENTORY_KUBECONFIG_FILE?: string
}

export interface Config {
  publicUrl: string
  apiUrl: string
  uiClientId: string
  oidcIssuer: string
  tokenExchangeClientId: string
  tokenExchangeClientSecret: string
  inventory: {
    enabled: boolean
    kubeconfig: string
    kubeconfigFile: string
  }
}

export function loadConfig(source: ConfigSource): Config {
  const publicUrl = absoluteUrl(
    required(source.HUB_PUBLIC_URL, 'HUB_PUBLIC_URL'),
    'HUB_PUBLIC_URL',
  )
  return {
    publicUrl,
    apiUrl: `${publicUrl}/api`,
    uiClientId: required(source.HUB_UI_CLIENT_ID, 'HUB_UI_CLIENT_ID'),
    oidcIssuer: absoluteUrl(
      required(source.OIDC_ISSUER, 'OIDC_ISSUER'),
      'OIDC_ISSUER',
    ),
    tokenExchangeClientId: required(
      source.TOKEN_EXCHANGE_CLIENT_ID,
      'TOKEN_EXCHANGE_CLIENT_ID',
    ),
    tokenExchangeClientSecret: required(
      source.TOKEN_EXCHANGE_CLIENT_SECRET,
      'TOKEN_EXCHANGE_CLIENT_SECRET',
    ),
    inventory: {
      enabled: source.INVENTORY_ENABLED?.trim() === 'true',
      kubeconfig: source.INVENTORY_KUBECONFIG?.trim() || '',
      kubeconfigFile: source.INVENTORY_KUBECONFIG_FILE?.trim() || '',
    },
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
