# Codex fixture: rollout format 0.162

A synthetic copy of `~/.codex` in the format Codex wrote on 2026-10-14 (ChatGPT.app 26.1007, rollout `cli_version` 0.162.0-alpha.17.2). Every ID, path, name, and text in it is made up. Tests copy this folder to a temporary home as `.codex`.

- `session_index.jsonl`: four lines. The user thread appears twice (it was renamed, so the last line wins), and there is one line for the child thread and one for an archived thread whose rollout is gone.
- `sessions/2026/01/15/rollout-…-…a1.jsonl`: a user thread with three turns. The first ends with a final answer, the second is stopped by the user (`turn_aborted`), and the third ends with a `server_overloaded` error. It also holds the record types AgentPeek ignores, such as `world_state`, `turn_context`, `token_usage_record`, and `compacted`, and the context Codex adds as user messages (`<environment_context>`, AGENTS.md).
- `sessions/2026/01/15/rollout-…-…a2.jsonl`: a `guardian_review` child thread of the user thread. AgentPeek does not list it.

When Codex changes its format, add a fixture for the new version next to this one and keep this one.
