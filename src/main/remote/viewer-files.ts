import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The viewer build output (TASK-005), read into memory when the listener starts. */
export interface ViewerFiles {
  /** `index.html`, or null when the viewer was not built (a development checkout). */
  page: Buffer | null
  /** Keyed by request path, `/assets/<name>.js|.css`. */
  assets: ReadonlyMap<string, ViewerAsset>
}

export interface ViewerAsset {
  body: Buffer
  type: string
}

const ASSET_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
}

/**
 * Reads `out/remote-web`: AgentPeek's own build, never a path from a request. Requests are matched
 * against these in-memory files by exact path, so no request can name a file on disk.
 */
export async function loadViewerFiles(folder: string): Promise<ViewerFiles> {
  const page = await readFile(join(folder, 'index.html')).catch(() => null)
  const assets = new Map<string, ViewerAsset>()
  const entries = await readdir(join(folder, 'assets'), { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const type = ASSET_TYPES[entry.name.slice(entry.name.lastIndexOf('.'))]
    if (!entry.isFile() || type === undefined) continue
    const body = await readFile(join(folder, 'assets', entry.name)).catch(() => null)
    if (body) assets.set(`/assets/${entry.name}`, { body, type })
  }
  return { page, assets }
}
