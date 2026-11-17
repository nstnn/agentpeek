import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// The viewer page runs in a browser on another device. It may import its own files, the pure
// shared code in src/core (which ESLint keeps free of Node.js and Electron), and React. It must
// never reach Electron, Node.js, the desktop renderer, the preload API or the main process. This
// test follows every import, type-only ones included, from each viewer source file. The Markdown
// parser (TASK-033) is allowed only in the one file that renders message text inert.

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const viewerSrc = join(repo, 'remote/web/src')
const allowedDirs = [viewerSrc, join(repo, 'src/core')]
const allowedPackages = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'])
const testOnlyPackages = new Set(['vitest', '@testing-library/react'])
const inertMarkdown = join(viewerSrc, 'InertMarkdown.tsx')
const markdownPackages = new Set(['react-markdown', 'remark-gfm'])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx)$/.test(name) ? [path] : []
  })
}

function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]
  return candidates.find((path) => existsSync(path) && statSync(path).isFile())
}

function isTestFile(path: string): boolean {
  return /\.test\.tsx?$/.test(path)
}

/** Returns every import that leaves the allowed set, as "importer -> specifier". */
function boundaryViolations(entries: string[]): string[] {
  const violations: string[] = []
  const seen = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const imports = ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles
    for (const { fileName: specifier } of imports) {
      const from = relative(repo, file)
      if (!specifier.startsWith('.')) {
        const allowed =
          allowedPackages.has(specifier) ||
          (file === inertMarkdown && markdownPackages.has(specifier)) ||
          (isTestFile(file) && testOnlyPackages.has(specifier))
        if (!allowed) violations.push(`${from} -> ${specifier}`)
        continue
      }
      const target = resolveRelative(file, specifier)
      if (target === undefined) {
        // A stylesheet next to the viewer source is fine; anything else unresolved is not.
        if (!(specifier.endsWith('.css') && file.startsWith(viewerSrc))) {
          violations.push(`${from} -> ${specifier} (unresolved)`)
        }
        continue
      }
      if (!allowedDirs.some((dir) => target.startsWith(dir + '/'))) {
        violations.push(`${from} -> ${relative(repo, target)}`)
        continue
      }
      if (/\.tsx?$/.test(target)) queue.push(target)
    }
  }
  return violations
}

describe('Remote View page import boundary', () => {
  it('imports only its own files, src/core and React', () => {
    expect(boundaryViolations(sourceFiles(viewerSrc))).toEqual([])
  })

  it('keeps the Markdown parser to the inert renderer', () => {
    const elsewhere = join(viewerSrc, 'SessionDetail.tsx')
    expect(readFileSync(elsewhere, 'utf8')).not.toMatch(/from 'react-markdown'/)
    expect(boundaryViolations([inertMarkdown])).toEqual([])
  })

  it('accepts the shared protocol module', () => {
    expect(boundaryViolations([join(repo, 'src/core/remote/protocol.ts')])).toEqual([])
  })

  it('rejects Electron, Node.js and desktop code', () => {
    const violations = boundaryViolations([
      join(repo, 'src/preload/index.ts'),
      join(repo, 'src/renderer/src/main.tsx')
    ])
    expect(violations.some((v) => v.endsWith('-> electron'))).toBe(true)
    expect(violations.some((v) => v.includes('src/renderer/src/main.tsx ->'))).toBe(true)
  })
})
