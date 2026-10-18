# Sessions connection

AgentPeek reads its local sources while its window is open, shows a live session count, and refreshes on focus, wake, and Reload Sessions. Fixture runs name the synthetic home in a persistent banner. Closing or quitting stops the service and its watches and timers.

## Sub-features

- `fixture-isolation` confirms the synthetic home and state profile before any interaction.
- `session-count` shows the fixture's listed sessions and updates after a fixture file change.
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
- `launch --label sessions-connection --fixture <absolute-synthetic-home>` succeeded. Record its run ID, home, and userData paths.

- **Isolation.** Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs doctor`. Every check passes, including `fixture mode confirmed by the app`. Save `aria sessions-connection-initial` and `screenshot sessions-connection-initial`; the banner names the run's synthetic home and the count matches the known listed IDs. An empty fixture shows `0 sessions`.
- **Live count.** Append a new, recent synthetic session to this run's copied home using the fixture simulator, without changing application state through eval. Run `aria sessions-connection-updated` and `screenshot sessions-connection-updated`. The count increases and the window stays focused on the same content.
- **Reload.** Run `focus`, save `menu sessions-connection-before-reload`, then `menu-click "View > Reload Sessions"`. It reports `clicked: true` via its click handler. Save `aria sessions-connection-after-reload` and `screenshot sessions-connection-after-reload`. Observe the snapshot's `takenAt` before and after with `eval "window.agentpeek.getSnapshot().then(s => ({count: s.sessions.length, takenAt: s.takenAt}))"`; it advances and the fixture count remains correct.
- **Focus.** Bring another app forward, then run `focus`. After the debounce, observe the snapshot timestamp and count with the same read-only expression and capture `aria sessions-connection-after-focus`. Unit tests separately assert coalescing and cancellation.
- **Stop.** Choose `menu-click "Window > Close Window"`, then `wait-exit --timeout 3000` and `stop`. The app exits, `clean` is true, and no helper process or debug port remains. The synthetic state save stays inside the isolated profile; `defaultProfileUnchanged` is true.

## Gotchas

- File watchers can deliver the fixture change before Reload Sessions. A changed count alone does not prove the menu refreshed; also compare snapshot timestamps around the real menu action.
- Do not use eval to choose a session or invoke its actions. The list/detail entry points are not built in TASK-011. Selection-aware menus, safe arguments, subscriptions, fixed app bundles, and clipboard dispatch have synthetic contract tests until those entry points exist.
- Wake wiring has a synthetic lifecycle test. A real system sleep/wake remains Not tested unless actually observed; never put the user's Mac to sleep for an unattended check.
- Fixture process checks always report alive and never inspect the user's running tools. They do not prove real process liveness or missing-tool activation.
