export type MicrophonePermissionState =
  | PermissionState
  | 'unsupported'
  | 'unknown'

type PermissionReader = {
  query: (descriptor: { name: string }) => Promise<{ state: PermissionState }>
}

export async function readMicrophonePermission(
  permissions?: PermissionReader,
): Promise<MicrophonePermissionState> {
  const reader =
    permissions ??
    (typeof navigator !== 'undefined' ? navigator.permissions : undefined)
  if (!reader?.query) return 'unsupported'

  try {
    const status = await reader.query({ name: 'microphone' })
    return status.state
  } catch {
    // Safari versions that do not expose microphone through Permissions API
    // must not be treated as a denied microphone permission.
    return 'unsupported'
  }
}
