# AgentPeek

AgentPeek is a macOS app that shows what your local AI coding agents are doing. Open it to see which Codex and Claude Code sessions on your Mac are running, waiting for you, have a new reply, or failed. It only reads the tools' own local files: it never changes them, never stores conversation text, and makes no network requests.

AgentPeek is built with Electron, TypeScript, and React.

**Status: early development.** The app opens its window, but it does not read any sessions yet.

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

## Check

| Command             | What it does                                              |
| ------------------- | --------------------------------------------------------- |
| `npm run typecheck` | Type-checks the main process and the renderer separately. |
| `npm run lint`      | Runs ESLint, then checks formatting with Prettier.        |
| `npm test`          | Runs the unit tests with vitest.                          |
| `npm run format`    | Rewrites files in the Prettier style.                     |

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

ESLint enforces the import rules. Tests sit next to the code they test, as `*.test.ts`.

## Contributing

[AGENTS.md](AGENTS.md) lists the project-wide rules for anyone changing the code, including coding agents.
