import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { AccessRefusedError, createAccessGate } from './access'
import { readSmallFile } from './small-file-reader'

// Synthetic files only, in a temporary folder that stands in for the home folder.
let root: string
let home: string
let registry: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentpeek-small-file-'))
  home = join(root, 'home')
  registry = join(home, '.claude', 'sessions')
  await mkdir(registry, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('readSmallFile', () => {
  it('reads a whole file as text', async () => {
    const path = join(registry, '4242.json')
    await writeFile(path, '{"synthetic":"ä"}\n')
    expect(await readSmallFile(createAccessGate(home), path, 1024)).toEqual({
      kind: 'text',
      text: '{"synthetic":"ä"}\n'
    })
  })

  it('reads an empty file and a file of exactly the cap', async () => {
    const empty = join(registry, '1.json')
    const full = join(registry, '2.json')
    await writeFile(empty, '')
    await writeFile(full, 'x'.repeat(100))
    const gate = createAccessGate(home)
    expect(await readSmallFile(gate, empty, 100)).toEqual({ kind: 'text', text: '' })
    expect(await readSmallFile(gate, full, 100)).toEqual({ kind: 'text', text: 'x'.repeat(100) })
  })

  it('reports a file over the cap, reading only one byte past it', async () => {
    const path = join(registry, '4242.json')
    await writeFile(path, 'x'.repeat(200 * 1024))
    const realGate = createAccessGate(home)
    // The spy records each read and passes it through.
    const reads: MockInstance[] = []
    const gate = {
      resolve: (file: string) => realGate.resolve(file),
      open: async (file: string) => {
        const handle = await realGate.open(file)
        reads.push(vi.spyOn(handle, 'read'))
        return handle
      }
    }
    expect(await readSmallFile(gate, path, 100 * 1024)).toEqual({ kind: 'too-large' })
    const requested = reads.flatMap((read) => read.mock.calls.map((call) => Number(call[2])))
    expect(requested.reduce((sum, length) => sum + length, 0)).toBe(100 * 1024 + 1)
  })

  it('goes through the access gate', async () => {
    const outside = join(root, 'outside.json')
    await writeFile(outside, '{}')
    const link = join(registry, '4242.json')
    await symlink(outside, link)
    const gate = createAccessGate(home)
    await expect(readSmallFile(gate, link, 1024)).rejects.toBeInstanceOf(AccessRefusedError)
    await expect(readSmallFile(gate, join(registry, '4242.key'), 1024)).rejects.toMatchObject({
      reason: 'credential'
    })
    await expect(readSmallFile(gate, join(registry, '1.json'), 1024)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})
