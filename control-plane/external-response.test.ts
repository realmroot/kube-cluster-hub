import { describe, expect, it } from 'vitest'
import {
  boundedResponseJson,
  boundedResponseText,
  ExternalResponseError,
} from './external-response'

describe('bounded external responses', () => {
  it('parses JSON within the byte limit', async () => {
    await expect(
      boundedResponseJson(
        new Response(new TextEncoder().encode('{"ok":true}')),
      ),
    ).resolves.toEqual({ ok: true })
  })

  it('rejects a declared response larger than the byte limit', async () => {
    await expect(
      boundedResponseText(
        new Response('small', { headers: { 'Content-Length': '100' } }),
        10,
      ),
    ).rejects.toThrow(ExternalResponseError)
  })

  it('cancels a streamed response after it crosses the byte limit', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8))
        controller.enqueue(new Uint8Array(8))
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(boundedResponseText(new Response(body), 10)).rejects.toThrow(
      'external response exceeds size limit',
    )
    expect(cancelled).toBe(true)
  })

  it('rejects malformed JSON', async () => {
    await expect(boundedResponseJson(new Response('{'))).rejects.toThrow(
      'external response is not valid JSON',
    )
  })
})
