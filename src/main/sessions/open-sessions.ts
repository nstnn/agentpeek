import type { SessionsSnapshot } from '../../core/snapshot'
import { createAccessGate } from './access'
import { createClaudeSource } from './claude-source'
import type { ProcessProbe } from './claude-process'
import { createCodexSource } from './codex-source'
import { createFileWatcher, type ChangeListener, type SessionWatcher } from './file-watcher'
import { createSessionsService, type SessionsService } from './service'
import { openStateStore } from './state-store'
import { sessionFolderWatches } from './watch-folders'
import type { SourcePreferences } from '../../shared/preferences'

// Puts the sessions service together from the real parts. The main process (TASK-011) calls this
// once, then `start()`; tests and fixture mode swap in their own process checks.

export interface OpenSessionsOptions {
  /** The home folder whose tool files are read: the user's, or `AGENTPEEK_HOME` in fixture mode. */
  home: string
  /** AgentPeek's own folder for `state.json`: Electron's `userData`, or `AGENTPEEK_USER_DATA`. */
  stateFolder: string
  /** True when `home` holds synthetic data, for the "Fixture data" banner. */
  fixture: boolean
  enabledSources?: SourcePreferences
  onSnapshot: (snapshot: SessionsSnapshot) => void
  /** Whether the Codex app is running. The real check by default. */
  isCodexAppRunning?: () => Promise<boolean>
  /** The liveness check for Claude Code processes. The real check by default. */
  probe?: ProcessProbe
  /** The real `fs.watch` watcher by default. */
  createWatcher?: (onChange: ChangeListener) => SessionWatcher
  now?: () => number
}

/** Opens the store and builds the sources, the watcher, and the service. Nothing runs yet. */
export async function openSessionsService(options: OpenSessionsOptions): Promise<SessionsService> {
  const { home, now } = options
  const store = await openStateStore({ folder: options.stateFolder, now })
  // One access gate for the sources and the watcher.
  const gate = createAccessGate(home)
  return createSessionsService({
    sources: [
      createCodexSource({
        home,
        pinnedIds: () =>
          store
            .pinnedKeys()
            .filter((key) => key.tool === 'codex')
            .map((key) => key.id),
        gate,
        isAppRunning: options.isCodexAppRunning,
        now,
        fixture: options.fixture
      }),
      createClaudeSource({
        home,
        gate,
        probe: options.probe,
        now,
        pinnedIds: () =>
          store
            .pinnedKeys()
            .filter((key) => key.tool === 'claude')
            .map((key) => key.id)
      })
    ],
    store,
    createWatcher:
      options.createWatcher ??
      ((onChange) => createFileWatcher({ folders: sessionFolderWatches(home), onChange, gate })),
    onSnapshot: options.onSnapshot,
    fixture: options.fixture,
    enabledSources: options.enabledSources,
    now
  })
}
