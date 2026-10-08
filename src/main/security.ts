import { app, type Session } from 'electron'

/**
 * Keeps every page inside the app's own interface: it cannot navigate away, open new
 * windows, or embed a <webview>. Applies to every web contents the app creates.
 *
 * `allowReload` lets a page reload itself, which development hot reload needs.
 * Packaged builds block every navigation.
 */
export function installNavigationGuards({ allowReload }: { allowReload: boolean }): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event) => {
      if (allowReload && event.url === contents.getURL()) return
      event.preventDefault()
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })
}

/** Refuses every permission a page can ask for, such as camera, microphone, or notifications. */
export function denyAllPermissions(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
}
