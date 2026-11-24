import { dirname } from 'node:path'
import { antigravityPaths, classifyAntigravityPath } from './antigravity-files'
import { classifyPath, claudePaths } from './claude-files'
import { codexPaths, isRolloutPath } from './codex-files'
import type { FolderWatch } from './file-watcher'

/**
 * The folders AgentPeek watches, and the files that matter in each (the "Watching" assumption in
 * the plan, decided in TASK-002). `home` is the user's home folder, or `AGENTPEEK_HOME` in fixture
 * mode. Each filter is the one the tool's source uses to classify a path.
 */
export function sessionFolderWatches(home: string): FolderWatch[] {
  const claude = claudePaths(home)
  const codex = codexPaths(home)
  const antigravity = antigravityPaths(home)
  return [
    // `<pid>.json` only: never the `.key` file next to it.
    {
      tool: 'claude',
      folder: claude.registry,
      recursive: false,
      accepts: (path) => classifyPath(claude, path).kind === 'registry'
    },
    // `<project>/<session id>.jsonl` only: never `subagents/` or `tool-results/`.
    {
      tool: 'claude',
      folder: claude.projects,
      recursive: true,
      accepts: (path) => classifyPath(claude, path).kind === 'transcript'
    },
    // `<account>/<organization>/local_<id>.json` only.
    {
      tool: 'claude',
      folder: claude.catalog,
      recursive: true,
      accepts: (path) => classifyPath(claude, path).kind === 'catalog'
    },
    // `~/.codex` changes several times a second while Codex runs (its own state files); only the
    // index matters, and nothing else there is ever looked at.
    {
      tool: 'codex',
      folder: dirname(codex.index),
      recursive: false,
      accepts: (path) => path === codex.index
    },
    // New rollouts, and rollouts Codex closes. Appends to an open rollout need a file watch.
    {
      tool: 'codex',
      folder: codex.sessions,
      recursive: true,
      accepts: (path) => isRolloutPath(codex, path)
    },
    // `<conversation id>/.system_generated/logs/transcript.jsonl` only: never
    // `transcript_full.jsonl`, artifacts, or `.pb` stores. Antigravity closes the transcript after
    // each append, so this folder watch sees new conversations and every step (TASK-001).
    {
      tool: 'antigravity',
      folder: antigravity.brain,
      recursive: true,
      accepts: (path) => classifyAntigravityPath(antigravity, path).kind === 'transcript'
    },
    // `<conversation id>.pbtxt` only, for titles (DECISION-002).
    {
      tool: 'antigravity',
      folder: antigravity.annotations,
      recursive: false,
      accepts: (path) => classifyAntigravityPath(antigravity, path).kind === 'annotation'
    }
  ]
}
