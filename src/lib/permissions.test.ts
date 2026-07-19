import { describe, expect, it, vi } from 'vitest'
import { readMicrophonePermission } from './permissions'

describe('microphone permission observation', () => {
  it('returns the reported permission state', async () => {
    const query = vi.fn(async () => ({ state: 'granted' as const }))
    await expect(readMicrophonePermission({ query })).resolves.toBe('granted')
  })

  it('reports unsupported instead of denied when the API is absent', async () => {
    await expect(readMicrophonePermission(undefined)).resolves.toBe(
      'unsupported',
    )
  })

  it('reports unsupported when Safari rejects the microphone descriptor', async () => {
    const query = vi.fn(async () => {
      throw new TypeError('Unsupported permission name')
    })
    await expect(readMicrophonePermission({ query })).resolves.toBe(
      'unsupported',
    )
  })
})
