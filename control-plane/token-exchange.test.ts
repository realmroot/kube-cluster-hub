import { generateKeyPair, SignJWT } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import type { AgentPrincipal } from './domain'
import { AgentTokenExchanger, type TokenExchangeError } from './token-exchange'

const issuer = 'https://identity.example.test'
const targetAudience = 'kubernetes-client'
const clientId = 'hub-token-exchanger'

describe('Agent identity token exchange', () => {
  it('exchanges a validated Agent token for a verified Kubernetes ID token', async () => {
    const keys = await generateKeyPair('RS256')
    const principal = agent()
    const idToken = await new SignJWT({
      azp: clientId,
      act: { iss: principal.actor.issuer, sub: principal.actor.subject },
      groups: ['platform-admins'],
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(targetAudience)
      .setSubject(principal.controllerSubject)
      .setIssuedAt()
      .setExpirationTime(principal.expiresAt)
      .sign(keys.privateKey)
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({
          Authorization: `Basic ${btoa(`${clientId}:exchange-secret`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        })
        expect(String(init?.body)).toBe(
          'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token=agent-access-token&subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid_token&audience=kubernetes-client&scope=openid+groups',
        )
        return Response.json({
          access_token: idToken,
          issued_token_type: 'urn:ietf:params:oauth:token-type:id_token',
          token_type: 'Bearer',
          expires_in: 300,
          scope: 'openid groups',
        })
      },
    )
    const exchanger = new AgentTokenExchanger(
      {
        issuer,
        tokenEndpoint: `${issuer}/token`,
        keys: keys.publicKey,
      },
      clientId,
      'exchange-secret',
      targetAudience,
      fetcher as typeof fetch,
    )

    await expect(exchanger.exchange(principal)).resolves.toEqual({
      token: idToken,
      targetAudience,
      groups: ['platform-admins'],
    })
  })

  it('fails closed on policy denial and malformed exchange output', async () => {
    const keys = await generateKeyPair('RS256')
    const denied = new AgentTokenExchanger(
      { issuer, tokenEndpoint: `${issuer}/token`, keys: keys.publicKey },
      clientId,
      'exchange-secret',
      targetAudience,
      (async () =>
        Response.json(
          { error: 'invalid_target' },
          { status: 400 },
        )) as typeof fetch,
    )
    await expect(denied.exchange(agent())).rejects.toMatchObject({
      code: 'denied',
    } satisfies Partial<TokenExchangeError>)

    const malformed = new AgentTokenExchanger(
      { issuer, tokenEndpoint: `${issuer}/token`, keys: keys.publicKey },
      clientId,
      'exchange-secret',
      targetAudience,
      (async () =>
        Response.json({ access_token: 'not-a-jwt' })) as typeof fetch,
    )
    await expect(malformed.exchange(agent())).rejects.toMatchObject({
      code: 'invalid_response',
    } satisfies Partial<TokenExchangeError>)
  })
})

function agent(): AgentPrincipal {
  return {
    type: 'agent',
    controllerSubject: 'controller-1',
    actor: { issuer, subject: 'agent-1' },
    clientId: 'realmroot-cli',
    scopes: ['kubernetes:read'],
    scope: 'kubernetes:read',
    tokenId: 'source-token-1',
    token: 'agent-access-token',
    expiresAt: Math.floor(Date.now() / 1_000) + 300,
  }
}
