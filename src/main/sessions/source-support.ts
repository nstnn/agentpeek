// Small helpers both sources share.

/** Whether a file-system error means the file or folder is not there. */
export function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return error.code === 'ENOENT' || error.code === 'ENOTDIR'
}

/**
 * Runs tasks one at a time, in call order, so a reconcile and a refresh never change a source's
 * state at the same time.
 */
export function createQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve()
  return (task) => {
    const run = last.then(task, task)
    last = run.catch(() => undefined)
    return run
  }
}
