import { createServer, type Server } from 'node:http'
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from 'jose'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentVerifier,
  AuthenticationError,
  discoverIssuer,
  UserVerifier,
} from './auth'
import { NodeDatabaseAdapter } from './database-node'
import { migrateNodeDatabase } from './migrate-node'
import { Store } from './store'

describe('OIDC and OAuth Agent authentication', () => {
  let server: Server
  let issuer: string
  let signingKey: CryptoKey
  let signingKid: string
  let jwks: object
  let database: NodeDatabaseAdapter
  let store: Store

  beforeEach(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true })
    signingKey = pair.privateKey
    signingKid = 'issuer-key'
    const publicJwk = await exportJWK(pair.publicKey)
    publicJwk.kid = signingKid
    publicJwk.alg = 'RS256'
    publicJwk.use = 'sig'
    jwks = { keys: [publicJwk] }
    server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/.well-known/openid-configuration') {
        response.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }))
      } else if (request.url === '/jwks') {
        response.end(JSON.stringify(jwks))
      } else {
        response.statusCode = 404
        response.end('{}')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('test issuer address is unavailable')
    issuer = `http://127.0.0.1:${address.port}`
    database = new NodeDatabaseAdapter(':memory:')
    migrateNodeDatabase(database)
    store = new Store(database)
  })

  afterEach(async () => {
    database.raw.close()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  })

  it('validates a standard OIDC ID token and groups claim', async () => {
    const discovered = await discoverIssuer(issuer)
    const verifier = new UserVerifier(discovered, 'kubernetes-client', 'groups')
    const token = await new SignJWT({
      groups: ['platform-admins', 'developers'],
    })
      .setProtectedHeader({ alg: 'RS256', kid: signingKid })
      .setIssuer(issuer)
      .setAudience('kubernetes-client')
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signingKey)
    await expect(verifier.verify(`Bearer ${token}`)).resolves.toMatchObject({
      subject: 'user-1',
      groups: ['platform-admins', 'developers'],
    })
    await expect(verifier.verify('Bearer malformed')).rejects.toBeInstanceOf(
      AuthenticationError,
    )
  })

  it('validates DPoP binding, Agent actor identity, scope, and replay', async () => {
    const resource = 'https://gateway.example.com/api/agent'
    const proofPair = await generateKeyPair('ES256', { extractable: true })
    const proofPublicJwk = await exportJWK(proofPair.publicKey)
    const thumbprint = await calculateJwkThumbprint(proofPublicJwk)
    const accessToken = await new SignJWT({
      client_id: 'authorized-toolbox-client',
      scope: 'clusters:read kubernetes:read',
      act: { iss: issuer, sub: 'agent-1' },
      cnf: { jkt: thumbprint },
    })
      .setProtectedHeader({ alg: 'RS256', kid: signingKid, typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(resource)
      .setSubject('controller-1')
      .setJti('access-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signingKey)
    const targetBase = `${resource}/clusters/development/kubernetes/api/v1/pods`
    const target = `${targetBase}?watch=true&timeoutSeconds=2`
    const proof = await signProof(
      proofPair.privateKey,
      proofPublicJwk,
      accessToken,
      targetBase,
      'proof-1',
    )
    const verifier = new AgentVerifier(
      await discoverIssuer(issuer),
      resource,
      new Set(['authorized-toolbox-client']),
      ['RS256'],
      store,
    )
    await expect(
      verifier.verify(`DPoP ${accessToken}`, proof, 'GET', target),
    ).resolves.toMatchObject({
      controllerSubject: 'controller-1',
      actor: { issuer, subject: 'agent-1' },
      scopes: ['clusters:read', 'kubernetes:read'],
    })
    await expect(
      verifier.verify(`DPoP ${accessToken}`, proof, 'GET', target),
    ).rejects.toThrow('already used')
    const wrongTargetProof = await signProof(
      proofPair.privateKey,
      proofPublicJwk,
      accessToken,
      `${resource}/clusters/other/kubernetes/api/v1/pods`,
      'proof-2',
    )
    await expect(
      verifier.verify(`DPoP ${accessToken}`, wrongTargetProof, 'GET', target),
    ).rejects.toThrow('target URI does not match')
  })
})

async function signProof(
  key: CryptoKey,
  publicJwk: object,
  accessToken: string,
  target: string,
  jti: string,
): Promise<string> {
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
  return new SignJWT({ htm: 'GET', htu: target, ath })
    .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwk })
    .setJti(jti)
    .setIssuedAt()
    .sign(key)
}
