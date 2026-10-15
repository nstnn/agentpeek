import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkFolder,
  classifyPath,
  claudePaths,
  findTranscript,
  listCatalogFiles,
  listRegistryFiles,
  projectFolderName,
  statFile
} from './claude-files'

// Synthetic files only, in a temporary folder that stands in for the home folder.
const SESSION = '00000000-0000-4000-8000-000000000001'

let root: string
let home: string
let paths: ReturnType<typeof claudePaths>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentpeek-claude-files-'))
  home = join(root, 'home')
  paths = claudePaths(home)
})

afterEach(async () => {
  await chmod(paths.catalog, 0o755).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})

async function touch(path: string, text = '{}'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text)
}

describe('claudePaths', () => {
  it('names the registry, the transcripts, and the Claude.app catalog', () => {
    expect(claudePaths('/Users/synthetic')).toEqual({
      registry: '/Users/synthetic/.claude/sessions',
      projects: '/Users/synthetic/.claude/projects',
      catalog: '/Users/synthetic/Library/Application Support/Claude/claude-code-sessions'
    })
  })
})

describe('classifyPath', () => {
  it('recognizes registry files, but not key files', () => {
    expect(classifyPath(paths, join(paths.registry, '4242.json'))).toEqual({ kind: 'registry' })
    for (const name of ['4242.abc.key', 'x.json', '4242.json.tmp', '.4242.json']) {
      expect(classifyPath(paths, join(paths.registry, name))).toEqual({ kind: 'other' })
    }
    expect(classifyPath(paths, join(paths.registry, 'sub', '4242.json'))).toEqual({
      kind: 'other'
    })
  })

  it('recognizes catalog files two folders down', () => {
    const file = join(paths.catalog, 'a', 'b', `local_${SESSION}.json`)
    expect(classifyPath(paths, file)).toEqual({ kind: 'catalog' })
    for (const path of [
      join(paths.catalog, 'a', `local_${SESSION}.json`),
      join(paths.catalog, 'a', 'b', 'c', `local_${SESSION}.json`),
      join(paths.catalog, 'a', 'b', 'scheduled-tasks.json'),
      join(paths.catalog, 'a', 'b', `local_${SESSION}.json.tmp`),
      join(paths.catalog, '.a', 'b', `local_${SESSION}.json`)
    ]) {
      expect(classifyPath(paths, path)).toEqual({ kind: 'other' })
    }
  })

  it('recognizes transcripts at the top level of a project folder only', () => {
    expect(classifyPath(paths, join(paths.projects, 'folder', `${SESSION}.jsonl`))).toEqual({
      kind: 'transcript',
      sessionId: SESSION
    })
    for (const path of [
      join(paths.projects, `${SESSION}.jsonl`),
      join(paths.projects, 'folder', SESSION, 'subagents', 'agent-1.jsonl'),
      join(paths.projects, 'folder', SESSION, 'tool-results', 'x.jsonl'),
      join(paths.projects, '.folder', `${SESSION}.jsonl`),
      join(paths.projects, 'folder', '.jsonl'),
      join(paths.projects, 'folder', `${SESSION}.json`),
      join(home, '.claude', 'history.jsonl'),
      'relative/path.jsonl'
    ]) {
      expect(classifyPath(paths, path)).toEqual({ kind: 'other' })
    }
  })

  it('ignores paths with `.` or `..` parts, which the access gate refuses', () => {
    // Joined by hand: `join` would remove the parts.
    for (const path of [
      [paths.projects, 'folder', '..', 'folder', `${SESSION}.jsonl`],
      [paths.projects, '.', 'folder', `${SESSION}.jsonl`],
      [paths.projects, 'folder', '', `${SESSION}.jsonl`],
      [paths.registry, '..', 'sessions', '4242.json'],
      [paths.catalog, 'a', '.', 'b', `local_${SESSION}.json`]
    ].map((parts) => parts.join(sep))) {
      expect(classifyPath(paths, path)).toEqual({ kind: 'other' })
    }
  })
})

describe('projectFolderName', () => {
  it('replaces every character but letters and digits with a dash', () => {
    expect(projectFolderName('/Users/synthetic/my.project_2')).toBe('-Users-synthetic-my-project-2')
    expect(projectFolderName('/Users/synthetic/Thư mục')).toBe('-Users-synthetic-Th--m-c')
  })
})

describe('listRegistryFiles', () => {
  it('lists only `<pid>.json` files, with their signatures', async () => {
    await touch(join(paths.registry, '4242.json'))
    await touch(join(paths.registry, '4242.abcdef.key'), 'synthetic')
    await touch(join(paths.registry, 'notes.json'))
    await mkdir(join(paths.registry, '77.json'))
    const files = await listRegistryFiles(paths)
    expect(files.map((file) => file.path)).toEqual([join(paths.registry, '4242.json')])
    expect(files[0]?.signature).toMatch(/^\d+:\d+:2:\d+(\.\d+)?$/)
  })

  it('reports a missing folder to the caller', async () => {
    await expect(listRegistryFiles(paths)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('listCatalogFiles', () => {
  it('lists `local_*.json` files two folders down, and nothing else', async () => {
    const file = join(paths.catalog, 'account', 'organization', `local_${SESSION}.json`)
    await touch(file)
    await touch(join(paths.catalog, 'account', 'organization', 'scheduled-tasks.json'))
    await touch(join(paths.catalog, 'account', 'organization', 'archived-sessions.idx'))
    await mkdir(join(paths.catalog, 'account', 'organization', `deleted_${SESSION}`))
    await touch(join(paths.catalog, 'account', `local_${SESSION}.json`))
    await touch(join(paths.catalog, '.hidden', 'organization', `local_${SESSION}.json`))
    await touch(join(root, 'elsewhere', `local_${SESSION}.json`))
    await symlink(join(root, 'elsewhere'), join(paths.catalog, 'account', 'linked'))
    expect((await listCatalogFiles(paths)).map((entry) => entry.path)).toEqual([file])
  })

  it('reports a missing folder to the caller', async () => {
    await expect(listCatalogFiles(paths)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('statFile', () => {
  it('changes its signature when the file changes', async () => {
    const path = join(paths.registry, '4242.json')
    await touch(path, '{"status":"idle"}')
    const before = await statFile(path)
    await writeFile(path, '{"status":"busy"}')
    await utimes(path, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    const after = await statFile(path)
    expect(before?.signature).not.toBe(after?.signature)
    expect(await statFile(join(paths.registry, '1.json'))).toBeNull()
    expect(await statFile(paths.registry)).toBeNull()
  })
})

describe('findTranscript', () => {
  it('finds a transcript in the folder named after the working folder', async () => {
    const path = join(paths.projects, '-Users-synthetic-demo', `${SESSION}.jsonl`)
    await touch(path, '')
    expect(await findTranscript(paths, SESSION, ['/Users/synthetic/demo'])).toMatchObject({
      path
    })
  })

  it('searches every project folder when the name does not match', async () => {
    const path = join(paths.projects, '-Users-synthetic-shortened-name-1a2b3c', `${SESSION}.jsonl`)
    await touch(path, '')
    expect(await findTranscript(paths, SESSION, ['/Users/synthetic/other'])).toMatchObject({
      path
    })
    expect(await findTranscript(paths, SESSION, [])).toMatchObject({ path })
  })

  it('returns null when there is no transcript, or for an ID that is not a plain name', async () => {
    await touch(join(paths.projects, 'folder', 'x.jsonl'), '')
    expect(await findTranscript(paths, SESSION, ['/Users/synthetic/demo'])).toBeNull()
    for (const id of ['../x', '.hidden', 'a/b', '']) {
      expect(await findTranscript(paths, id, [])).toBeNull()
    }
    await rm(paths.projects, { recursive: true })
    expect(await findTranscript(paths, SESSION, [])).toBeNull()
  })
})

describe('checkFolder', () => {
  it('tells a present folder from a missing one and one it cannot list', async () => {
    expect(await checkFolder(paths.catalog)).toBe('missing')
    await mkdir(paths.catalog, { recursive: true })
    expect(await checkFolder(paths.catalog)).toBe('present')
    await chmod(paths.catalog, 0o000)
    expect(await checkFolder(paths.catalog)).toBe('no-access')
  })
})
