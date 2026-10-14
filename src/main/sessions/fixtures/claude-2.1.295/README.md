# Claude Code fixture: files written by Claude Code 2.1.295

A synthetic copy of Claude Code's files in the format observed on 2026-10-14 (Claude.app with Claude Code 2.1.284 to 2.1.295). Every ID, path, name, and text in it is made up. Tests copy `claude/` to a temporary home as `.claude`, and `claude-code-sessions/` to `Library/Application Support/Claude/claude-code-sessions`.

- `claude-code-sessions/…a0/…b0/`: Claude.app's catalog, one `local_<id>.json` per session. The file name's ID is Claude.app's own; the session is named by `cliSessionId`. The files also hold settings AgentPeek ignores (`permissionMode`, `mcpServers`).
  - `local_…d1.json`: session `…c1`.
  - `local_…d2.json`: session `…c2`.
  - `local_…d3.json`: session `…c3`, archived. AgentPeek does not list it.
- `claude/sessions/`: the runtime registry.
  - `48151.json`: session `…c1` is waiting for a permission prompt.
  - `48152.json`: a short-lived helper process. Its session `…c4` has no catalog entry and no transcript, so AgentPeek does not list it.
- `claude/projects/-Users-synthetic-projects-demo/`: one transcript per session.
  - `…c1.jsonl`: a turn that ends with a final reply, split into a thinking record and a text record, and tool calls before it. Then Claude Code's caveat (`isMeta`), and a second turn waiting on a `WebFetch` permission. It also has a custom title and bookkeeping records without a time.
  - `…c2.jsonl`: a final reply; a turn that ends on a denied permission; a stopped turn; a background task's message (`origin.kind: task-notification`, not a prompt) and the reply to it; a compaction summary; a prompt whose content is a list of parts; and a turn that ends with a `rate_limit` API error. It also has a malformed line and record types AgentPeek ignores.
  - `…c3.jsonl`: the archived session's transcript.

When Claude Code changes its format, add a fixture for the new version next to this one and keep this one.
