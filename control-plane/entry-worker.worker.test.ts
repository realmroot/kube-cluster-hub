/// <reference types="@cloudflare/vitest-plugin/types" />
import { describe, expect, it } from 'vitest'
import { withSecurityHeaders } from './entry-worker'

describe('Worker WebSocket response boundary', () => {
  it('preserves the upgraded WebSocket instead of reconstructing the response', () => {
    const pair = new WebSocketPair()
    const response = new Response(null, {
      status: 101,
      webSocket: pair[0],
    })

    const secured = withSecurityHeaders(response)

    expect(secured).toBe(response)
    expect(secured.status).toBe(101)
    expect(secured.webSocket).toBe(pair[0])
  })
})
