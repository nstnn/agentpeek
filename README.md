# AgentPeek

AgentPeek is a macOS app that shows what your local AI coding agents are doing. Open it to see which Codex and Claude Code sessions on your Mac are running, waiting for you, have a new reply, or failed. It only reads the tools' own local files: it never changes them, never stores conversation text, and makes no network requests.

AgentPeek is built with Electron, TypeScript, and React.

**Status: early development.** The app reads local Codex and Claude Code sessions while open. The sessions list has Active, Pinned, and All Sessions views, tool filters, source health, keyboard selection, and Session/context menus. Session detail shows recent messages with safe Markdown, long-message expansion, actions, automatic read-on-focused-view, and narrow-window Back. The list and detail have automated and synthetic built-app verification.

## Requirements

- macOS on Apple Silicon
- Node.js 20.19+ or 22.13+, with npm

## Set up

```bash
npm install
```

## Run

Start AgentPeek in development mode, with hot reload:

```bash
npm run dev
```

Build it into `out/`, then run the build:

```bash
npm run build
```

```bash
npm start
```

Agent runs use synthetic data. Provide both absolute paths together; incomplete fixture overrides
are rejected so a fixture run cannot fall back to real sessions or real saved state:

```bash
AGENTPEEK_HOME=/absolute/path/to/synthetic-home AGENTPEEK_USER_DATA=/absolute/path/to/synthetic-state npm start
```

Fixture mode shows a persistent banner naming the synthetic home. Its process checks treat fixture
tools and registry owners as alive; it never checks the user's running tools.

## Package

Build a local Apple Silicon app without launching it:

```bash
npm run package
```

The result is `dist/mac-arm64/AgentPeek.app`, versioned from `package.json`, with a placeholder
icon and About panel. The bundle is ad-hoc signed with hardened runtime and the required Electron
fuses: Node mode, `NODE_OPTIONS`, and the main-process inspector are disabled; code loads only
from the integrity-checked `app.asar`. It has no updater, publishing, Developer ID signing, or
notarization. This is a local build; the command does not install it into `/Applications`.

Inspect the build without opening a window:

```bash
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/AgentPeek.app
codesign -dv --verbose=4 dist/mac-arm64/AgentPeek.app
npx --no-install @electron/fuses read --app dist/mac-arm64/AgentPeek.app
```

The ad-hoc hardened runtime needs JIT and library-validation entitlements for Electron on arm64;
these live in `build/entitlements.mac.plist`. The renderer's sandbox and process boundary still
apply. Use the unpackaged `out/` build for Playwright and the verification helper, because the
packaged app disables the inspector. Agent-run packaged checks need launch approval and both
synthetic fixture overrides, just like development runs.

## Check

| Command                     | What it does                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `npm run typecheck`         | Type-checks the main process and the renderer separately.                                           |
| `npm run lint`              | Runs ESLint, then checks formatting with Prettier.                                                  |
| `npm test`                  | Runs the unit tests with vitest.                                                                    |
| `npm run fixture -- create` | Creates an isolated synthetic home for regression checks.                                           |
| `npm run e2e`               | Opens the built app twice for the Playwright fixture smoke; build first and obtain launch approval. |
| `npm run format`            | Rewrites files in the Prettier style.                                                               |

The [fixture guide](scripts/fixture/README.md) lists the simulator commands and expected states.
The smoke checks bootstrap, a live update within 2 seconds, safe detail rendering, persisted pins
and requests limited to the app's renderer files. It uses temporary fixture/profile folders,
removes them after the run, and retains evidence in ignored `test-results/e2e/`. It does not
replace manual system, accessibility, packaged-build or consented real-data acceptance.

## Project layout

AgentPeek follows Electron's process model. Only the main process touches files and the system; the window shows what the main process sends it.

| Folder              | What runs there                                                                                               | It may import                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `src/main/*.ts`     | Electron main process: app lifecycle, window, menus                                                           | Electron, Node.js                  |
| `src/main/sessions` | Reading and watching the tools' files, the sessions service, and saving AgentPeek's own state (plain Node.js) | Node.js, but not Electron          |
| `src/preload`       | The bridge that exposes `window.agentpeek`                                                                    | Electron's `contextBridge`         |
| `src/renderer`      | The React interface, in a sandboxed window                                                                    | React, but not Node.js or Electron |
| `src/core`          | Pure logic shared by the other parts                                                                          | Nothing from Node.js or Electron   |
| `src/shared`        | Types used on both sides of the bridge                                                                        | Nothing from Node.js or Electron   |

ESLint enforces the import rules. Tests sit next to the code they test, as `*.test.ts` or `*.test.tsx`. Renderer component tests use Testing Library in jsdom; source and main-process tests use Node.js.

## Contributing

[AGENTS.md](AGENTS.md) lists the project-wide rules for anyone changing the code, including coding agents.
