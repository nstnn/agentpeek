import { mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isTailnetHostName, REMOTE_DEFAULT_PORT } from '../../core/remote/protocol'

// Remote View settings (TASK-014): whether the listener runs, its port, and the login and Mac
// address it admits. They live in their own file next to the preferences and hold no secret, no
// session data and nothing from Tailscale. TASK-015 adds the shared projects and the title option.

export const REMOTE_SETTINGS_FILE = 'remote-view.json'

const MAX_FILE_BYTES = 4096
const MIN_PORT = 1024
const MAX_PORT = 65535
/** The longest email address; Tailscale logins are emails or `name@github`-style names. */
const MAX_LOGIN_LENGTH = 254

export interface RemoteConnection {
  /** The owner's Tailscale login, compared exactly with `Tailscale-User-Login`. */
  ownerLogin: string
  /** The Mac's `<device>.<tailnet>.ts.net` name, lowercase, without scheme or port. */
  hostName: string
  /** The loopback port that `tailscale serve` forwards to. */
  port: number
}

export interface RemoteSettings extends RemoteConnection {
  enabled: boolean
}

/** Fresh install: off, nothing configured. */
export const DEFAULT_REMOTE_SETTINGS: Readonly<RemoteSettings> = {
  enabled: false,
  ownerLogin: '',
  hostName: '',
  port: REMOTE_DEFAULT_PORT
}

export type ConnectionField = keyof RemoteConnection

export type ConnectionCheck =
  { ok: true; connection: RemoteConnection } | { ok: false; invalid: ConnectionField[] }

/** Trims and lowercases what the owner typed, then checks each field. */
export function checkConnection(input: {
  ownerLogin: unknown
  hostName: unknown
  port: unknown
}): ConnectionCheck {
  const ownerLogin = typeof input.ownerLogin === 'string' ? input.ownerLogin.trim() : ''
  const hostName = typeof input.hostName === 'string' ? input.hostName.trim().toLowerCase() : ''
  const port = input.port
  const invalid: ConnectionField[] = []
  if (!isOwnerLogin(ownerLogin)) invalid.push('ownerLogin')
  if (!isTailnetHostName(hostName)) invalid.push('hostName')
  if (!isPort(port)) invalid.push('port')
  return invalid.length === 0
    ? { ok: true, connection: { ownerLogin, hostName, port: port as number } }
    : { ok: false, invalid }
}

/** Whether the listener can start: a login and a Mac address are set and valid. */
export function isConfigured(settings: RemoteConnection): boolean {
  return checkConnection(settings).ok
}

/** One `name@domain` without spaces, control characters or commas. */
function isOwnerLogin(value: string): boolean {
  return (
    value.length <= MAX_LOGIN_LENGTH &&
    /^[\x21-\x2b\x2d-\x3f\x41-\x7e]+@[\x21-\x2b\x2d-\x3f\x41-\x7e]+$/.test(value)
  )
}

function isPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= MIN_PORT && (value as number) <= MAX_PORT
}

export type RemoteSettingsLoad = { ok: true; settings: RemoteSettings } | { ok: false }

/**
 * A missing file is a fresh install. A file that cannot be read or does not hold valid settings is
 * a load failure, which keeps Remote View off for this run instead of guessing.
 */
export async function loadRemoteSettings(folder: string): Promise<RemoteSettingsLoad> {
  let text: string
  try {
    const handle = await open(join(folder, REMOTE_SETTINGS_FILE), 'r')
    try {
      if ((await handle.stat()).size > MAX_FILE_BYTES) return { ok: false }
      text = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, settings: { ...DEFAULT_REMOTE_SETTINGS } }
    }
    return { ok: false }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false }
  const saved = value as Record<string, unknown>
  if (saved.version !== 1 || typeof saved.enabled !== 'boolean') return { ok: false }
  const { enabled, ownerLogin, hostName, port } = saved
  // An empty login or address is a valid saved state (not configured yet); a set one must be
  // exactly what `checkConnection` saves, already trimmed and lowercased.
  if (typeof ownerLogin !== 'string' || (ownerLogin !== '' && !isOwnerLogin(ownerLogin))) {
    return { ok: false }
  }
  if (typeof hostName !== 'string' || (hostName !== '' && !isTailnetHostName(hostName))) {
    return { ok: false }
  }
  if (!isPort(port)) return { ok: false }
  return { ok: true, settings: { enabled, ownerLogin, hostName, port } }
}

/** Writes the settings atomically, readable only by the user. Throws a fixed error on failure. */
export async function saveRemoteSettings(folder: string, settings: RemoteSettings): Promise<void> {
  const file = join(folder, REMOTE_SETTINGS_FILE)
  const temporary = `${file}.tmp`
  try {
    await mkdir(folder, { recursive: true })
    await rm(temporary, { force: true })
    const handle = await open(temporary, 'wx', 0o600)
    try {
      const { enabled, ownerLogin, hostName, port } = settings
      await handle.writeFile(
        `${JSON.stringify({ version: 1, enabled, ownerLogin, hostName, port })}\n`,
        'utf8'
      )
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw new Error('Could not save Remote View settings.')
  }
}
