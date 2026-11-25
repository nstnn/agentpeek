# Security policy

AgentPeek reads the local session files of Codex, Claude Code, and Google Antigravity Desktop,
which can contain private conversations. Security reports are welcome and taken seriously.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub:
**Security → Report a vulnerability** on this repository. Do not open a public issue.

Please include the AgentPeek version or commit, your macOS version, and steps to reproduce.
Use synthetic data only: never attach real conversation text, session files, or credentials.

## In scope

- AgentPeek writing, renaming, locking, or deleting any Codex, Claude Code, or Antigravity file or
  setting.
- Reading files outside AgentPeek's path allowlist, including credential files.
- Conversation text being logged, stored, or sent anywhere, or any network request made by the app.
- Remote View, the one opt-in network feature (see the README): the listener accepting connections
  beyond `127.0.0.1`, answering anyone other than the owner's Tailscale login, or sending anything
  beyond what its settings allow (status fields, titles only when shared, and bounded recent
  messages only while that option is on).
- Escaping the renderer sandbox, bypassing context isolation, or calling IPC handlers with
  unvalidated senders or arguments.
- Script execution or unsafe links through rendered message content.

## Supported versions

Only the latest commit on `main` receives fixes.
