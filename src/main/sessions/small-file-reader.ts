import type { AccessGate } from './access'

// A capped read of a whole small file: Claude Code's JSON files (the Desktop catalog and the
// runtime registry), which are rewritten whole rather than appended. Every read goes through the
// access gate. The text holds titles and folder names: never log it.

export type SmallFileResult =
  | { kind: 'text'; text: string }
  // The file is larger than the cap. It is not read further.
  | { kind: 'too-large' }

/** How much is read at a time. */
const CHUNK_BYTES = 64 * 1024

/** Reads a whole file as UTF-8 text, or reports that it is larger than `maxBytes`. */
export async function readSmallFile(
  gate: AccessGate,
  path: string,
  maxBytes: number
): Promise<SmallFileResult> {
  const handle = await gate.open(path)
  try {
    const chunks: Buffer[] = []
    let total = 0
    // Reading one byte past the cap is how a file over the cap shows itself, even one that grows
    // while it is read.
    while (total <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, maxBytes + 1 - total))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      total += bytesRead
    }
    if (total > maxBytes) return { kind: 'too-large' }
    return { kind: 'text', text: Buffer.concat(chunks).toString('utf8') }
  } finally {
    await handle.close()
  }
}
