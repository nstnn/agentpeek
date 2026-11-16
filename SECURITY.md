# Security policy

AgentPeek reads the local session files of Codex and Claude Code, which can contain private
conversations. Security reports are welcome and taken seriously.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub:
**Security → Report a vulnerability** on this repository. Do not open a public issue.

Please include the AgentPeek version or commit, your macOS version, and steps to reproduce.
Use synthetic data only: never attach real conversation text, session files, or credentials.

## In scope

- AgentPeek writing, renaming, locking, or deleting any Codex or Claude Code file or setting.
- Reading files outside AgentPeek's path allowlist, including credential files.
- Conversation text being logged, stored, or sent anywhere, or any network request made by the app.
- Escaping the renderer sandbox, bypassing context isolation, or calling IPC handlers with
  unvalidated senders or arguments.
- Script execution or unsafe links through rendered message content.

## Supported versions

Only the latest commit on `main` receives fixes.
