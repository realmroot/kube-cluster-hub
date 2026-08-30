const defaultLimit = 64 * 1024

export class ExternalResponseError extends Error {}

export async function boundedResponseJson(
  response: Response,
  limit = defaultLimit,
): Promise<unknown> {
  const text = await boundedResponseText(response, limit)
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new ExternalResponseError('external response is not valid JSON', {
      cause,
    })
  }
}

export async function boundedResponseText(
  response: Response,
  limit = defaultLimit,
): Promise<string> {
  const declared = response.headers.get('Content-Length')
  if (declared !== null && Number(declared) > limit) {
    await response.body?.cancel()
    throw new ExternalResponseError('external response exceeds size limit')
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) {
        await reader.cancel()
        throw new ExternalResponseError('external response exceeds size limit')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}
