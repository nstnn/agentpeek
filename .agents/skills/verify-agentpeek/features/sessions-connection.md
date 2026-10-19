# Sessions connection

AgentPeek reads its local sources while its window is open, shows live session totals in the sidebar, and refreshes on focus, wake, and Reload Sessions. Fixture runs name the synthetic home in a persistent banner. Closing or quitting stops the service and its watches and timers.

## Sub-features

- `fixture-isolation` confirms the synthetic home and state profile before any interaction.
- `session-count` shows the fixture's capped session total and reconciles listed membership after a fixture change.
- `session-reload` refreshes through View > Reload Sessions.
- `session-focus` refreshes after the window regains focus, with a brief debounce.
- `session-stop` exits cleanly through Close Window or Quit.

## How to get to it (user POV)

- Open AgentPeek normally; an agent uses a synthetic fixture run instead.
- Keep the window open while the fixture simulator adds a session or finishes a turn.
- Choose View > Reload Sessions, or return focus to the window.
- Close the window or choose Quit.

## Driving it with agentpeek.mjs

Preconditions:

- The user approved launches for this task. The supplied fixture is entirely synthetic, with recent timestamps and known listed IDs; never copy real sessions into it.
- Use `node scripts/fixture/index.mjs create` for the generated fixture below; record the original home for cleanup. Read scripts/fixture/README.md. It starts with 100 listed sessions and seven running; its old Codex thread is outside the listed set.
- `launch --label sessions-connection --fixture <absolute-synthetic-home>` succeeded. Record its run ID, home, and userData paths.

- **Isolation.** Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs doctor`. Every check passes, including `fixture mode confirmed by the app`. Save `aria sessions-connection-initial` and `screenshot sessions-connection-initial`; the banner names the run's synthetic home and the count matches the known listed IDs. An empty fixture shows All Sessions with 0 and "No sessions yet".
- **Live membership.** Keep a different row selected. Run `node scripts/fixture/index.mjs simulate <copied-home> old-resumed`, then choose `menu-click "View > Reload Sessions"` and open All Sessions. Save `aria sessions-connection-updated` and `screenshot sessions-connection-updated`: Fixture Codex old appears as Running. The default fixture stays at 100 total (50 per tool); the newly listed ID replaces another at the cap. Check membership and count rather than expecting an increase from a simulator that has no add-session step.
- **Reload.** Run `focus`, save `menu sessions-connection-before-reload`, then `menu-click "View > Reload Sessions"`. It reports `clicked: true` via its click handler. Save `aria sessions-connection-after-reload` and `screenshot sessions-connection-after-reload`. Observe the snapshot's `takenAt` before and after with `eval "window.agentpeek.getSnapshot().then(s => ({count: s.sessions.length, takenAt: s.takenAt}))"`; it advances and the fixture count remains correct.
- **Focus.** Run `blur`, record the snapshot timestamp, then run `focus`. After the debounce/publication settles, observe a newer timestamp and the count with the same read-only expression and capture `aria sessions-connection-after-focus`. This proves native window blur/focus handling, not a physical app switch. Unit tests separately assert coalescing and cancellation.
- **Stop.** Choose `menu-click "Window > Close Window"`, then `wait-exit --timeout 3000` and `stop`. Require `cleanExit: true` before cleanup, then `clean: true`. The synthetic state save stays inside the isolated profile; inspect `defaultProfileUnchanged`. Clean the generator-owned original with `node scripts/fixture/index.mjs clean <original-home>` after the run; keep evidence.

## Gotchas

- File watchers can deliver fixture changes before Reload Sessions. Changed membership/count alone does not prove the menu refreshed; compare snapshot timestamps around the real menu action after any focus refresh settles.
- Do not use eval to choose a session or invoke its actions. Drive list selection through click/keys and menus; see sessions-list.md. Detail entry points are covered in session-detail.md.
- Wake wiring has a synthetic lifecycle test. A real system sleep/wake remains Not tested unless actually observed; never put the user's Mac to sleep for an unattended check.
- Fixture process checks always report alive and never inspect the user's running tools. They do not prove real process liveness or missing-tool activation.
