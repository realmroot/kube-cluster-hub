import {
  calculateJwkThumbprint,
  createRemoteJWKSet,
  decodeProtectedHeader,
  importJWK,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from 'jose'
import type { AgentPrincipal, UserPrincipal } from './domain'
import { ConflictError } from './domain'
import type { HubStore } from './store'

const proofLifetimeSeconds = 300

export class AuthenticationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

interface IssuerKeys {
  issuer: string
  keys: JWTVerifyGetKey
}

export async function discoverIssuer(issuer: string): Promise<IssuerKeys> {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok)
    throw new Error(`issuer discovery failed with ${response.status}`)
  const metadata = await response.json()
  if (!metadata || typeof metadata !== 'object')
    throw new Error('issuer discovery response is invalid')
  const value = metadata as Record<string, unknown>
  if (value.issuer !== issuer || typeof value.jwks_uri !== 'string')
    throw new Error('issuer discovery metadata is invalid')
  return { issuer, keys: createRemoteJWKSet(new URL(value.jwks_uri)) }
}

export class UserVerifier {
  constructor(
    private readonly issuer: IssuerKeys,
    private readonly audience: string,
    private readonly groupsClaim: string,
    private readonly tokenKind: 'id' | 'access' = 'id',
  ) {}

  async verify(authorization: string | undefined): Promise<UserPrincipal> {
    const token = bearerToken(authorization)
    try {
      const { payload, protectedHeader } = await jwtVerify(
        token,
        this.issuer.keys,
        {
          issuer: this.issuer.issuer,
          audience: this.audience,
        },
      )
      if (
        this.tokenKind === 'access' &&
        protectedHeader.typ?.toLowerCase() !== 'at+jwt'
      ) {
        throw new AuthenticationError(
          'invalid_token',
          'OAuth access token is required',
        )
      }
      if (
        this.tokenKind === 'access' &&
        typeof (payload.cnf as { jkt?: unknown } | undefined)?.jkt === 'string'
      ) {
        throw new AuthenticationError(
          'invalid_token',
          'DPoP-bound access token cannot be used as Bearer',
        )
      }
      if (!payload.sub)
        throw new AuthenticationError(
          'invalid_token',
          'token subject is missing',
        )
      const rawGroups = payload[this.groupsClaim]
      if (
        rawGroups !== undefined &&
        (!Array.isArray(rawGroups) ||
          rawGroups.some((group) => typeof group !== 'string'))
      ) {
        throw new AuthenticationError(
          'invalid_token',
          'token groups claim is invalid',
        )
      }
      return {
        type: 'user',
        subject: payload.sub,
        groups: (rawGroups as string[] | undefined) ?? [],
        scopes:
          typeof payload.scope === 'string'
            ? payload.scope.split(/\s+/).filter(Boolean)
            : [],
        token,
      }
    } catch (error) {
      if (error instanceof AuthenticationError) throw error
      throw new AuthenticationError(
        'invalid_token',
        `${this.tokenKind === 'access' ? 'access' : 'ID'} token verification failed`,
      )
    }
  }
}

interface AgentClaims extends JWTPayload {
  client_id?: string
  scope?: string
  act?: { iss?: string; sub?: string }
  cnf?: { jkt?: string }
}

interface ProofClaims extends JWTPayload {
  htm?: string
  htu?: string
  ath?: string
}

export class AgentVerifier {
  constructor(
    private readonly issuer: IssuerKeys,
    private readonly resource: string,
    private readonly authorizedClients: ReadonlySet<string>,
    private readonly algorithms: readonly string[],
    private readonly store: HubStore,
  ) {}

  async verify(
    authorization: string | undefined,
    proof: string | undefined,
    method: string,
    target: string,
  ): Promise<AgentPrincipal> {
    const token = dpopToken(authorization)
    const protectedHeader = decodeProtectedHeader(token)
    if (
      protectedHeader.typ?.toLowerCase() !== 'at+jwt' ||
      !protectedHeader.alg ||
      !this.algorithms.includes(protectedHeader.alg)
    ) {
      throw new AuthenticationError(
        'invalid_token',
        'access token header is invalid',
      )
    }
    let payload: AgentClaims
    try {
      payload = (
        await jwtVerify(token, this.issuer.keys, {
          issuer: this.issuer.issuer,
          audience: this.resource,
          algorithms: [...this.algorithms],
        })
      ).payload as AgentClaims
    } catch {
      throw new AuthenticationError(
        'invalid_token',
        'access token verification failed',
      )
    }
    if (
      !payload.sub ||
      !payload.jti ||
      !payload.client_id ||
      !this.authorizedClients.has(payload.client_id)
    ) {
      throw new AuthenticationError(
        'invalid_token',
        'access token identity is invalid',
      )
    }
    if (payload.act?.iss !== this.issuer.issuer || !payload.act.sub) {
      throw new AuthenticationError('invalid_token', 'Agent actor is invalid')
    }
    if (!payload.cnf?.jkt)
      throw new AuthenticationError(
        'invalid_token',
        'access token is not DPoP-bound',
      )
    const thumbprint = await verifyDpopProof(proof, token, method, target)
    if (thumbprint.jkt !== payload.cnf.jkt)
      throw new AuthenticationError(
        'invalid_token',
        'DPoP key does not match token',
      )
    try {
      await this.store.consumeDpopProof(
        thumbprint.jkt,
        thumbprint.jti,
        new Date(Date.now() + proofLifetimeSeconds * 1_000),
      )
    } catch (error) {
      if (error instanceof ConflictError)
        throw new AuthenticationError(
          'invalid_dpop_proof',
          'DPoP proof was already used',
        )
      throw error
    }
    const scopes = (payload.scope || '').split(/\s+/).filter(Boolean)
    return {
      type: 'agent',
      controllerSubject: payload.sub,
      actor: {
        issuer: payload.act.iss,
        subject: payload.act.sub,
      },
      clientId: payload.client_id,
      scopes,
      scope: payload.scope || '',
      tokenId: payload.jti,
      token,
    }
  }
}

async function verifyDpopProof(
  compact: string | undefined,
  accessToken: string,
  method: string,
  target: string,
): Promise<{ jkt: string; jti: string }> {
  if (!compact)
    throw new AuthenticationError(
      'invalid_dpop_proof',
      'DPoP proof is required',
    )
  let header: ReturnType<typeof decodeProtectedHeader>
  try {
    header = decodeProtectedHeader(compact)
  } catch {
    throw new AuthenticationError(
      'invalid_dpop_proof',
      'DPoP proof is malformed',
    )
  }
  const jwk = header.jwk as JWK | undefined
  if (
    header.typ?.toLowerCase() !== 'dpop+jwt' ||
    header.alg !== 'ES256' ||
    !jwk ||
    'd' in jwk
  ) {
    throw new AuthenticationError(
      'invalid_dpop_proof',
      'DPoP proof header is invalid',
    )
  }
  let payload: ProofClaims
  try {
    const key = await importJWK(jwk, 'ES256')
    payload = (await jwtVerify(compact, key, { algorithms: ['ES256'] }))
      .payload as ProofClaims
  } catch {
    throw new AuthenticationError(
      'invalid_dpop_proof',
      'DPoP proof signature is invalid',
    )
  }
  const now = Math.floor(Date.now() / 1_000)
  if (!payload.jti || !payload.iat) {
    throw new AuthenticationError(
      'invalid_dpop_proof',
      'DPoP proof identity claims are invalid',
    )
  }
  if (payload.htm !== method.toUpperCase())
    throw new AuthenticationError(
      'invalid_dpop_proof',
      'DPoP HTTP method does not match request',
    )
  if (payload.htu !== dpopTarget(target))
    throw new AuthenticationError(
      'invalid_dpop_proof',
      'DPoP target URI does not match request',
    )
  if (payload.iat < now - proofLifetimeSeconds || payload.iat > now + 60) {
    throw new AuthenticationError('invalid_dpop_proof', 'DPoP proof is stale')
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(accessToken),
    ),
  )
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  const ath = btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  if (payload.ath !== ath)
    throw new AuthenticationError(
      'invalid_dpop_proof',
      'DPoP token hash is invalid',
    )
  return { jkt: await calculateJwkThumbprint(jwk, 'sha256'), jti: payload.jti }
}

function dpopTarget(target: string): string {
  const url = new URL(target)
  url.search = ''
  url.hash = ''
  return url.toString()
}

function bearerToken(value: string | undefined): string {
  const parts = value?.trim().split(/\s+/) ?? []
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer' || !parts[1]) {
    throw new AuthenticationError('invalid_token', 'Bearer token is required')
  }
  return parts[1]
}

function dpopToken(value: string | undefined): string {
  const parts = value?.trim().split(/\s+/) ?? []
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'dpop' || !parts[1]) {
    throw new AuthenticationError(
      'invalid_token',
      'DPoP access token is required',
    )
  }
  return parts[1]
}
