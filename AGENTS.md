# AgentPeek

AgentPeek is a standalone macOS app built with Electron, TypeScript, and React. While its window is open, it shows which local Codex and Claude Code sessions are running, waiting for the user, have new replies, or failed. It only reads the tools' local files and never changes them.

## Where to look

- [`README.md`](README.md): what AgentPeek is, its status, how to set it up, run, and check it, and the source folder layout.
- [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md): product behavior, scope, privacy rules, and open decisions; it separates planned from implemented behavior.
- [`plan/agent-sessions/agent-sessions.md`](plan/agent-sessions/agent-sessions.md): Phase 1 requirements, constraints, and task cards, plus the observed formats of the tools' local files.

`docs/` and `plan/` are local and ignored by Git, so other checkouts may not have them.

## Project rules

- Treat Codex and Claude Code data as read-only. Never write, rename, lock, or delete their files, and never change their configuration.
- Read tool files only through the path allowlist. Never open `.key` files, `auth.json`, or other credential files. See the plan's CONSTRAINT-001.
- Show conversation text only on screen. Never log or store it, never put it in fixtures, tests, or evidence, and never send it anywhere. AgentPeek makes no network requests, and tests use synthetic data only.
- Keep the Electron process boundary:
  - File and system access live in the main process.
  - The renderer runs sandboxed, with context isolation and without Node integration.
  - The renderer reaches the main process only through one typed preload API. Its IPC handlers validate the sender and every argument.
  - Ask before relaxing any of these settings.
- AgentPeek runs only when the user opens it. It has no background process, tray or menu bar item, login item, auto-update, or telemetry.
- AgentPeek is standalone. It shares no code, storage, or integration with other projects.
- Ask before launching anything that opens a window. Agent-run launches use synthetic fixture data, unless the user agrees to real data for that run. Afterwards, quit every process you started.
- Never commit `plan/` or `docs/`, and commit or push only when the user asks. Write code, documentation, plans, and commit messages in English.

## Working with project documents

Read the documents relevant to a change and update them when their content becomes inaccurate. Change `AGENTS.md` only when a project-wide rule, the core project identity, or this document map changes.
