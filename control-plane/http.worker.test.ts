/// <reference types="@cloudflare/vitest-plugin/types" />
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Variables } from './app-dependencies'
import { installHttpBoundary } from './http'

describe('Worker HTTP boundary', () => {
  it('does not reconstruct an upgraded WebSocket while adding request metadata', async () => {
    const app = new Hono<{ Variables: Variables }>()
    installHttpBoundary(app)
    const pair = new WebSocketPair()
    app.get(
      '/socket',
      () => new Response(null, { status: 101, webSocket: pair[0] }),
    )

    const response = await app.request('https://hub.example/socket', {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
    })

    expect(response.status).toBe(101)
    expect(response.webSocket).toBe(pair[0])
  })
})
