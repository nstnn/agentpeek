import { isShareableWorkspace, normalizeWorkspace } from '../../core/remote/share-policy'
import type { AppSnapshot } from '../../shared/api'

// Folder choices for Remote View's "Add Project…" (TASK-016). The main process checks each choice
// again against the sessions it lists; this only decides what the list offers.

export function folderName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Folders AgentPeek lists that can be shared and are not shared yet, by folder name. */
export function candidateFolders(
  snapshot: AppSnapshot | null,
  shared: readonly string[]
): string[] {
  const found = new Set<string>()
  for (const session of snapshot?.sessions ?? []) {
    const folder = normalizeWorkspace(session.summary.workspacePath)
    if (isShareableWorkspace(folder) && !shared.includes(folder)) found.add(folder)
  }
  return [...found].sort((a, b) => folderName(a).localeCompare(folderName(b)) || a.localeCompare(b))
}
