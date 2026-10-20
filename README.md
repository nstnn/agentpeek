# AgentPeek

AgentPeek is a macOS app that shows what your local AI coding agents are doing. Open it to see which Codex and Claude Code sessions on your Mac are running, waiting for you, have a new reply, or failed. It only reads the tools' own local files: it never changes them, never stores conversation text, and makes no network requests.

AgentPeek is built with Electron, TypeScript, and React.

**Status: Phase 1 implemented; final acceptance pending.** The app has live session lists,
Active/Pinned/All Sessions views, tool filters, source health, safe message detail, pin/read
actions, two session panes, keyboard navigation and a local macOS package. Automated tests and approved synthetic
built-app checks cover the implemented paths. VoiceOver speech, physical sleep/wake, external
app/browser actions and a complete real-session comparison still need acceptance evidence.

Right-click a session and choose **Open to the Right**, or drag its row into the right-side
preview to split the view. Once split, the context menu and drag previews can replace either
**Left pane** or **Right pane**. Clicking or focusing a pane makes it active; ordinary row
clicks open in that pane. The list names the destination, and the active pane has a labeled
accent header. Escape or an outside drop cancels a drag without changing either session.
Only a successfully loaded, active visible reply/error is marked read while the window is
focused; waiting still requires action in the tool.

At 1300+ content pixels the shared list and both panes appear together. At 1000–1299,
**Show Sessions** opens the list and **Return to Sessions** resumes reading; below 1000,
**Left pane** and **Right pane** select one detail at a time. Each pane keeps its own scroll
and disclosures across browsing and resizing. **Close Right Pane** restores the single-pane
layout. The layout and selected sessions reset when the app quits or reloads.

## Requirements

- macOS on Apple Silicon
- Node.js 22.13+ in the 22.x line, or Node.js 24+, with npm (the packaging fuse tool requires 22.12+)

## Set up

```bash
npm ci
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
Create the synthetic home and state paths with `npm run fixture -- create`; see the
[fixture guide](scripts/fixture/README.md) for simulation and cleanup. Both `npm run dev` and
`npm start` open a window. Agent-run launches require approval for the current task.

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
The smoke checks bootstrap, a live update within 2 seconds, safe detail rendering, independent
Main/Second selection, inactive/hidden reply isolation, compact Back/Return, close-to-single,
layout reset on relaunch, persisted pins and requests limited to the app's renderer files.
It uses temporary fixture/profile folders,
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

The local documentation set contains `docs/REQUIREMENTS.md` (implemented behavior, scope and
acceptance limits), `docs/ARCHITECTURE.md` (processes, data flow and security), and
`plan/agent-sessions/evidence/acceptance.md` (the Phase 1 acceptance record). `docs/` and `plan/`
are intentionally ignored by Git and may be absent in another checkout. The versioned
[verification map](.agents/skills/verify-agentpeek/features/README.md) and fixture guide remain
available there.
