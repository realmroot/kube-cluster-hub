import { exportJWK, generateKeyPair } from 'jose'

const pair = await generateKeyPair('ES256', { extractable: true })
const kid = crypto.randomUUID()
const privateJwk = await exportJWK(pair.privateKey)
const publicJwk = await exportJWK(pair.publicKey)
for (const jwk of [privateJwk, publicJwk]) {
  jwk.kid = kid
  jwk.alg = 'ES256'
  jwk.use = 'sig'
}
process.stdout.write(`DISPATCH_SIGNING_PRIVATE_JWK=${JSON.stringify(privateJwk)}\n`)
process.stdout.write(
  `DISPATCH_SIGNING_PUBLIC_JWKS=${JSON.stringify({ keys: [publicJwk] })}\n`,
)
