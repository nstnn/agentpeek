# Synthetic regression fixture

All IDs, titles, paths inside tool records and messages are invented. Formats match Codex
`0.162.0-alpha.17.2` and Claude Code `2.1.295`; the original format examples remain in
`src/main/sessions/fixtures/`. No real tool file or configuration is read or changed.

```bash
npm run fixture -- create
```

This creates a fresh OS-temp root and prints absolute `home` and `userData` paths. It seeds 63
Codex rollouts and 59 Claude transcripts, with titles and catalog/registry files. Each tool
lists 50 sessions after its cap. Active initially shows seven running sessions and no unread
historical replies. The nine-day-old Codex thread is initially outside the tracked set.
Use `create codex` or `create claude` to omit that tool at bootstrap.

After approving a window-opening run, launch the built app on those **two** isolated paths:

```bash
AGENTPEEK_HOME=<home> AGENTPEEK_USER_DATA=<userData> npm start
```

Or use the project verification helper with `--fixture <home>`; it copies the synthetic home.
For that run, apply simulator steps to the helper's **copied** `homeDir` from `run.json`.
Do not mutate the original and expect the copied run to change.

```bash
npm run fixture -- simulate <absolute-home> codex-complete
```

Each command writes once and exits; there is no polling or automatic scenario loop. Wait for
the expected UI result between steps. Fresh fixtures avoid stale state between scenarios.

| Step                             | Session and expected result                                                                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex-complete`                 | Codex complete: Running → Idle, New reply when unselected.                                                                                                           |
| `codex-error`                    | Codex error: Running → Idle, Error.                                                                                                                                  |
| `codex-aborted`                  | Codex aborted: Running → Idle, no reply/error attention.                                                                                                             |
| `codex-reply`                    | Codex complete: a fresh completed turn, new unread cursor.                                                                                                           |
| `codex-new-turn`                 | Codex complete: starts a newer turn, clearing unseen attention.                                                                                                      |
| `skill-references`               | Codex retry: append explicit skill cards for recorded, current, missing, long, empty and blocked content. Use the helper's copied home so paths stay isolated.       |
| `skill-local-updated`            | Replace the generated current local skill; Reload Skill shows the updated version.                                                                                   |
| `skill-missing-restored`         | Create the generated missing skill; Try Again recovers its current local content.                                                                                    |
| `claude-skill`                   | Claude busy: append a slash skill invocation, synthetic recorded skill copy and reply. The card uses transcript content only.                                        |
| `claude-waiting`                 | Claude busy: Running → Waiting for you (permission).                                                                                                                 |
| `claude-denied`                  | Claude busy: denied tool result + interrupt, then Idle, no reply/error.                                                                                              |
| `claude-stopped`                 | Claude stopped: interrupt, then Idle, no reply/error.                                                                                                                |
| `claude-api-error`               | Claude apiError: API error, then Idle, Error.                                                                                                                        |
| `claude-reply`                   | Claude busy: human prompt + completed reply, then Idle, New reply.                                                                                                   |
| `claude-new-turn`                | Claude busy: newer human prompt + busy registry, clearing attention.                                                                                                 |
| `registry-removed`               | Claude dead: removes the synthetic non-existent PID's registry; catalog-backed row becomes Idle.                                                                     |
| `old-resumed`                    | Old Codex thread: starts a turn; Reload Sessions discovers it as Running.                                                                                            |
| `malformed-line`                 | Appends invalid JSON to Codex malformed; ignored without affecting the other source.                                                                                 |
| `read-failure`, `read-restored`  | Removes/restores permission on Codex retry's transcript for failed-read/Try Again.                                                                                   |
| `missing-codex`, `restore-codex` | Hides/restores only the generated Codex tree; Reload Sessions updates health.                                                                                        |
| `antigravity-seed`               | Run on the original home **before** `launch --fixture`: adds Antigravity idle (shortened reply), running, and quiet (Unknown after 15 min) conversations; once only. |

Codex long has more than 20 messages, a tool summary, a long title, and a 211,200-character reply.
Codex hostile has literal HTML, an unsafe link, a remote image, a table, and a code block.
Codex retry has five `exec` calls: multiple literal nested names, comment/string lookalikes,
a dynamic call, a truncated long input, and missing input. Claude busy has seven calls: a Bash
description, an Edit diff, a Read range, a failed Bash with its error, an ID-named MCP tool, a
truncated Write with literal script text, and a last Bash with no result yet (Running, or Waiting
after `claude-waiting`). These inputs are synthetic text only.
`antigravity-seed` writes `~/.gemini/antigravity` transcripts and titles for three
conversations: Fixture Antigravity idle (a finished turn whose reply is marked shortened by the
tool, so the detail shows the truncation notice), running (an open turn one minute old) and
quiet (an open turn 20 minutes old: Unknown · Quiet for 15 min). Each has one `view_file` tool
group. Fixture mode confirms the app is running, so the running row stays Running for about 14
minutes after seeding. Active then shows eight running sessions. Seed a fresh home: the step
refuses to reuse an existing `.gemini` folder.
The simulator accepts only marked synthetic homes under the OS temp folder and rejects
symlinked targets. It cannot operate on the real home folder.

Fixture mode deliberately treats all owners as alive. These high synthetic PIDs are data only:
the scripts never signal them. Unit/service regression injects a dead-owner probe to prove
Unknown → Idle after registry removal. Built-app fixture runs prove removal only; real PID
liveness, physical sleep/wake and app activation require separate user checks.

After quitting the app, remove a generator-owned fixture:

```bash
npm run fixture -- clean <absolute-home>
```

For a helper-owned copied run, use the helper's `stop` command instead.

Build, then run `npm run e2e` **only after window-launch approval**. The Playwright smoke uses
the local Electron binary and `out/`; it needs no browser download. Its test entry point installs
a request observer before loading the built main module, so bootstrap loads are included.
It records rather than blocks requests, and asserts every observed request is a renderer file.
It keeps the Chromium sandbox enabled. See [Playwright's Electron API](https://playwright.dev/docs/api/class-electron).
Screenshots, accessibility snapshots, latency, action records, request URLs and cleanup results
are saved under ignored `test-results/e2e/`. The smoke launches twice to check pin persistence;
retries are disabled. Temporary profiles and homes are removed on success and failure.
