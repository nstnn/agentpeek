# Development

Requires macOS on Apple Silicon and Node.js 22.13+ (22.x) or 24+.

```bash
npm ci
npm run dev        # development mode with hot reload
npm run build      # build into out/
npm start          # run the build
```

**Synthetic data.** `npm run fixture -- create` prints a synthetic home and state folder. Run with
both, as absolute paths; a run with only one is refused so it cannot fall back to real data:

```bash
AGENTPEEK_HOME=/abs/synthetic-home AGENTPEEK_USER_DATA=/abs/synthetic-state npm start
```

The window then shows a Fixture data banner. See the [fixture guide](scripts/fixture/README.md)
for simulated session changes.

**Package.** `npm run package` builds `dist/mac-arm64/AgentPeek.app` without installing it:
ad-hoc signed, hardened runtime, Node mode and the inspector disabled, code loaded only from the
integrity-checked `app.asar`. There is no updater, Developer ID signing or notarization. Check it
with `codesign --verify --deep --strict dist/mac-arm64/AgentPeek.app` and
`npx --no-install @electron/fuses read --app dist/mac-arm64/AgentPeek.app`.

| Command                       | What it does                                                         |
| ----------------------------- | -------------------------------------------------------------------- |
| `npm run typecheck`           | Type-checks the main process, the renderer and the Remote View page. |
| `npm run lint`                | ESLint, then Prettier formatting check (`npm run format` fixes it).  |
| `npm test`                    | Unit tests (vitest).                                                 |
| `npm run test:remote-web`     | Remote View page tests, including its import boundary.               |
| `npm run test:remote-browser` | Remote View page in headless Chrome through a simulated Serve.       |
| `npm run e2e`                 | Playwright specs against the built app on synthetic data.            |

`npm run e2e` opens app windows; set `AGENTPEEK_E2E_BACKGROUND=1` to keep them invisible and
unfocused while you work (focus is then emulated, so use a normal run for acceptance).

### Project layout

Only the main process touches files and the system; the window shows what it is sent. ESLint
enforces these import rules, and tests sit next to the code as `*.test.ts(x)`.

| Folder              | What runs there                                                     | It may import             |
| ------------------- | ------------------------------------------------------------------- | ------------------------- |
| `src/main/*.ts`     | Electron main process: lifecycle, window, menus                     | Electron, Node.js         |
| `src/main/sessions` | Reading and watching the tools' files, AgentPeek's own state        | Node.js, not Electron     |
| `src/main/remote`   | Remote View listener, limits, settings, sharing policy              | Node.js, not Electron     |
| `src/preload`       | The bridge that exposes `window.agentpeek`                          | Electron `contextBridge`  |
| `src/renderer`      | The React interface in a sandboxed window                           | React only                |
| `src/core`          | Pure logic shared by the other parts                                | No Node.js or Electron    |
| `src/shared`        | Types used on both sides of the bridge                              | No Node.js or Electron    |
| `remote/web`        | The Remote View page, a separate Vite build served to other devices | React and `src/core` only |
