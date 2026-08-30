import { type JWTPayload, jwtVerify } from 'jose'
import type { AgentPrincipal } from './domain'
import { boundedResponseJson } from './external-response'

const accessTokenType = 'urn:ietf:params:oauth:token-type:access_token'
const idTokenType = 'urn:ietf:params:oauth:token-type:id_token'
const tokenExchangeGrant = 'urn:ietf:params:oauth:grant-type:token-exchange'

interface IssuerMetadata {
  issuer: string
  tokenEndpoint: string
  keys: Parameters<typeof jwtVerify>[1]
}

export interface AgentIdentityToken {
  token: string
  targetAudience: string
  groups: readonly string[]
}

export class TokenExchangeError extends Error {
  constructor(
    readonly code: 'denied' | 'unavailable' | 'invalid_response',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export class AgentTokenExchanger {
  constructor(
    private readonly issuer: IssuerMetadata,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly targetAudience: string,
    private readonly fetcher: typeof fetch,
  ) {}

  async exchange(principal: AgentPrincipal): Promise<AgentIdentityToken> {
    const body = new URLSearchParams({
      grant_type: tokenExchangeGrant,
      subject_token: principal.token,
      subject_token_type: accessTokenType,
      requested_token_type: idTokenType,
      audience: this.targetAudience,
      scope: 'openid groups',
    })
    let response: Response
    try {
      response = await this.fetcher(this.issuer.tokenEndpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${basicCredential(this.clientId, this.clientSecret)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(10_000),
      })
    } catch (cause) {
      throw new TokenExchangeError(
        'unavailable',
        'Realmroot token exchange is unavailable',
        { cause },
      )
    }
    let payload: unknown
    try {
      payload = await boundedResponseJson(response)
    } catch (cause) {
      if (!response.ok) {
        throw new TokenExchangeError(
          response.status >= 500 ? 'unavailable' : 'denied',
          response.status >= 500
            ? 'Realmroot token exchange is unavailable'
            : 'Realmroot token exchange was denied',
          { cause },
        )
      }
      throw new TokenExchangeError(
        'invalid_response',
        'Realmroot token exchange response is invalid',
        { cause },
      )
    }
    if (!response.ok) {
      const error = record(payload)
      throw new TokenExchangeError(
        response.status >= 500 ? 'unavailable' : 'denied',
        typeof error?.error === 'string'
          ? `Realmroot token exchange failed: ${error.error}`
          : 'Realmroot token exchange was denied',
      )
    }
    const exchange = record(payload)
    const grantedScopes =
      typeof exchange?.scope === 'string'
        ? new Set(exchange.scope.split(/\s+/).filter(Boolean))
        : new Set<string>()
    if (
      exchange?.issued_token_type !== idTokenType ||
      typeof exchange.token_type !== 'string' ||
      exchange.token_type.toLowerCase() !== 'bearer' ||
      typeof exchange.access_token !== 'string' ||
      typeof exchange.expires_in !== 'number' ||
      exchange.expires_in <= 0 ||
      !grantedScopes.has('openid') ||
      !grantedScopes.has('groups')
    ) {
      throw new TokenExchangeError(
        'invalid_response',
        'Realmroot token exchange response is invalid',
      )
    }

    let claims: JWTPayload
    try {
      claims = (
        await jwtVerify(exchange.access_token, this.issuer.keys, {
          issuer: this.issuer.issuer,
          audience: this.targetAudience,
        })
      ).payload
    } catch (cause) {
      throw new TokenExchangeError(
        'invalid_response',
        'Exchanged Kubernetes ID token verification failed',
        { cause },
      )
    }
    const actor = record(claims.act)
    const groups = claims.groups
    if (
      claims.sub !== principal.controllerSubject ||
      claims.azp !== this.clientId ||
      actor?.iss !== principal.actor.issuer ||
      actor?.sub !== principal.actor.subject ||
      !Array.isArray(groups) ||
      groups.some((group) => typeof group !== 'string') ||
      !claims.exp ||
      claims.exp > principal.expiresAt
    ) {
      throw new TokenExchangeError(
        'invalid_response',
        'Exchanged Kubernetes ID token identity is invalid',
      )
    }
    return {
      token: exchange.access_token,
      targetAudience: this.targetAudience,
      groups,
    }
  }
}

function basicCredential(clientId: string, clientSecret: string): string {
  const bytes = new TextEncoder().encode(`${clientId}:${clientSecret}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
