import { connect } from 'node:net'
import { importJWK, SignJWT } from 'jose'

const clusterId = process.env.CONNECTOR_CLUSTER_ID || 'kind-realmroot'
const connectorPort = Number(process.env.CONNECTOR_PORT || '18082')
const pod = process.env.CONNECTOR_E2E_POD
if (!pod) throw new Error('CONNECTOR_E2E_POD is required')

const privateJwk = JSON.parse(process.env.DISPATCH_SIGNING_PRIVATE_JWK || '')
const key = await importJWK(privateJwk, 'ES256')
const uri = `/api/v1/namespaces/realmroot-demo/pods/${encodeURIComponent(pod)}/exec?command=echo&command=connector-websocket-ok&stdout=true&stderr=true`
const dispatch = await new SignJWT({
  cluster_id: clusterId,
  method: 'GET',
  uri,
  request_id: crypto.randomUUID(),
  principal_type: 'agent',
  controller_subject: 'connector-e2e-controller',
  agent_issuer: 'https://e2e.invalid',
  agent_subject: 'connector-e2e-agent',
  scopes: 'kubernetes:read kubernetes:write',
})
  .setProtectedHeader({ alg: 'ES256', typ: 'cag-dispatch+jwt', kid: privateJwk.kid })
  .setIssuer(process.env.DISPATCH_ISSUER)
  .setAudience(process.env.DISPATCH_AUDIENCE || 'kube-cluster-connector')
  .setIssuedAt()
  .setExpirationTime('30s')
  .setJti(crypto.randomUUID())
  .sign(key)

const socket = connect(connectorPort, '127.0.0.1')
const chunks = []
const timeout = setTimeout(() => socket.destroy(new Error('WebSocket acceptance timed out')), 10_000)
socket.on('data', (chunk) => chunks.push(chunk))
await new Promise((resolve, reject) => {
  socket.once('connect', resolve)
  socket.once('error', reject)
})
socket.write(
  `GET /clusters/${clusterId}/kubernetes${uri} HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${connectorPort}\r\n` +
    'Connection: Upgrade\r\n' +
    'Upgrade: websocket\r\n' +
    `Sec-WebSocket-Key: ${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')}\r\n` +
    'Sec-WebSocket-Version: 13\r\n' +
    'Sec-WebSocket-Protocol: v5.channel.k8s.io\r\n' +
    `Authorization: Bearer ${dispatch}\r\n\r\n`,
)
await new Promise((resolve, reject) => {
  socket.once('close', resolve)
  socket.once('error', reject)
})
clearTimeout(timeout)

const response = Buffer.concat(chunks)
const text = response.toString('utf8')
if (!text.includes('101 Switching Protocols')) throw new Error(`WebSocket upgrade failed: ${text.slice(0, 500)}`)
if (!text.includes('connector-websocket-ok')) throw new Error('exec output was not received over WebSocket')
console.log('Connector Kubernetes exec WebSocket acceptance passed')
