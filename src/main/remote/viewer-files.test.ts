import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadViewerFiles } from './viewer-files'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

it('serves only hashed JS/CSS build files, excluding unversioned files, maps and symlinks', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'agentpeek-viewer-'))
  folders.push(folder)
  const assets = join(folder, 'assets')
  await mkdir(assets)
  await writeFile(join(folder, 'index.html'), '<!doctype html><title>AgentPeek</title>')
  for (const name of [
    'index-AbC12345.js',
    'index-AbC12345.css',
    'unversioned.js',
    'unversioned.css',
    'worker.js',
    'index-AbC12345.js.map',
    'secret.json',
    'index-AbC12345.svg'
  ])
    await writeFile(join(assets, name), name)
  await symlink(join(assets, 'secret.json'), join(assets, 'link-AbC12345.js'))
  const viewer = await loadViewerFiles(folder)
  expect(viewer.page?.toString()).toContain('<title>AgentPeek</title>')
  expect([...viewer.assets.keys()].sort()).toEqual([
    '/assets/index-AbC12345.css',
    '/assets/index-AbC12345.js'
  ])
})
