# AgentPeek

AgentPeek is a standalone macOS app built with Electron, TypeScript, and React. While its window is open, it shows which local Codex and Claude Code sessions are running, waiting for the user, have new replies, or failed. It only reads the tools' local files and never changes them.

## Where to look

- [`README.md`](README.md): what AgentPeek is, its status, how to set it up, run, and check it, and the source folder layout.
- [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md): product behavior, scope, privacy rules, and approved decisions; it separates planned from implemented behavior.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): process boundaries, IPC, sources, state, security, and fixture mode.
- [`plan/agent-sessions/agent-sessions.md`](plan/agent-sessions/agent-sessions.md): Phase 1 requirements, constraints, and task cards, plus the observed formats of the tools' local files.
- [`plan/agent-sessions/evidence/acceptance.md`](plan/agent-sessions/evidence/acceptance.md): Phase 1 acceptance results, build identity, and checks that still need evidence.
- [`plan/remote-view/README.md`](plan/remote-view/README.md): Remote View plan (status-only beta implemented on `feat/remote-view`; bounded recent messages approved 2026-11-03 and implemented on synthetic data, not yet accepted), with its decision records, task cards, evidence, and the M1 handoff.

`docs/` and `plan/` are local and ignored by Git, so other checkouts may not have them.

## Project rules

- Treat Codex and Claude Code data as read-only. Never write, rename, lock, or delete their files, and never change their configuration.
- Read tool files only through the path allowlist. Never open `.key` files, `auth.json`, or other credential files. See the plan's CONSTRAINT-001.
- Show conversation text only on screen. Never log or store it, never put it in fixtures, tests, or evidence, and never send it anywhere except as the Remote View recent messages below. AgentPeek makes no outbound network requests, and tests use synthetic data only.
- The only network exception is Remote View (status beta, see `README.md`): an opt-in listener on 127.0.0.1, off by default, that only the user's own Tailscale login can reach. It may send approved status fields, and session titles only when the user turns that on. Message text may leave the Mac only as bounded recent messages while the user has turned on the separate "Share recent messages" option (implemented on `feat/remote-view`, not yet accepted), never full history, files, tool input or output, or link targets (a path typed in the text itself is sent as written). Read the approved decisions in `docs/REQUIREMENTS.md`, `plan/remote-view/design/scope-privacy-decision.md` and `plan/remote-view/design/recent-messages-decision.md` before changing it.
- Keep the Electron process boundary:
  - File and system access live in the main process.
  - The renderer runs sandboxed, with context isolation and without Node integration.
  - The renderer reaches the main process only through one typed preload API. Its IPC handlers validate the sender and every argument.
  - Ask before relaxing any of these settings.
- AgentPeek runs only when the user opens it. It has no background process, tray or menu bar item, login item, auto-update, or telemetry.
- AgentPeek is standalone. It shares no code, storage, or integration with other projects.
- Ask before launching anything that opens a window. Agent-run launches use synthetic fixture data, unless the user agrees to real data for that run. Afterwards, quit every process you started.
- Never commit `plan/` or `docs/`, and commit or push only when the user asks. Write code, documentation, plans, and commit messages in English.

## Verification

- After changing anything a user of AgentPeek can observe (what the window shows, its menus and shortcuts, how the window and app open, close, and quit, or what the page is allowed to do), follow [`.agents/skills/verify-agentpeek/SKILL.md`](.agents/skills/verify-agentpeek/SKILL.md) for the affected features and include the evidence in your report.
- No evidence means the change is not done. If verification cannot run, for example because the user declined a launch, report the change as unverified and say why.
- Adding or changing a feature updates `.agents/skills/verify-agentpeek/features/` in the same change.

## Working with project documents

Read the documents relevant to a change and update them when their content becomes inaccurate. Change `AGENTS.md` only when a project-wide rule, the core project identity, or this document map changes.
