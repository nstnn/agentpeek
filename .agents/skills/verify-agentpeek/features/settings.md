# Settings and appearance

Settings is fixed at the bottom of the expanded sidebar or icon rail and opens an in-window modal. Appearance offers System (default), Light and Dark, applies immediately and saves automatically across launches. Sources offers independent monitoring switches and each tool's actual health; see [Source monitoring](./source-monitoring.md). Remote View follows Sources; see [Remote View settings](./remote-settings.md). Close or Escape returns to the retained reading workspace; conversations covered by Settings do not acknowledge replies.

## Sub-features

- `settings-entry`: labeled sidebar button, rail gear, App menu Settings… and Command-comma.
- `settings-theme`: System/Light/Dark, immediate application and automatic saving.
- `settings-modal`: keyboard containment, Close/Escape, return focus and retained pane/scroll state.
- `settings-unread`: replies arriving behind Settings stay unread until the reading pane is presented again.
- `settings-persistence`: saved appearance is restored on a cold start.
- `settings-recovery`: failed load has Try Again; failed save restores the previous appearance and permits another choice.

## How to get to it (user POV)

- Click Settings at the bottom of the sidebar. After Collapse Views, click the gear at the bottom of the icon rail.
- Choose AgentPeek → Settings… or press Command-comma while the app is focused.
- Choose System, Light or Dark under Appearance → Theme. Use Tab and the radio group's arrow keys for keyboard access.
- Close Settings with its Close Settings button or Escape.

## Driving it with agentpeek.mjs

Preconditions:

- User approval covers synthetic launches for this task. Launch a generator fixture with `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs launch --label settings --fixture <synthetic-home>`, then require `doctor` to pass.
- For retained reading and unread checks, open synthetic sessions through the list and the existing pane placement menu. Use the helper-owned copied home for simulator changes.

- **Entry (`settings-entry`).** Save `aria settings-entry` and `screenshot settings-entry`. Run `click --role button --name "Settings"`, then `aria settings-system` and `screenshot settings-system`. The Settings dialog contains Appearance with three named radios, then Sources and Remote View (see [Source monitoring](./source-monitoring.md) and [Remote View settings](./remote-settings.md)). Run `key Escape`, `click --role button --name "Collapse Views"` and capture `settings-rail`; the gear stays at the bottom. Reopen through the gear. Close, run `focus`, save `menu settings-menu` and choose `menu-click "AgentPeek > Settings…"` using the observed App menu name. The same dialog opens. The menu snapshot must show Command-comma; physical accelerator delivery needs native keyboard evidence separately.
- **Theme (`settings-theme`).** Run `click --role radio --name "Dark"`, save `settings-dark` ARIA/PNG, then observe `main-eval "({source: electron.nativeTheme.themeSource, dark: electron.nativeTheme.shouldUseDarkColors})"` and `eval "({dark: matchMedia('(prefers-color-scheme: dark)').matches, background: getComputedStyle(document.documentElement).backgroundColor})"`. Repeat with Light and System, capturing each. Each choice agrees with native appearance and System removes the app override. Never change macOS appearance. Loading and saving status must settle before the next action.
- **Keyboard and layout (`settings-modal`).** Enter via sidebar, Tab/Shift-Tab around the dialog and use ArrowLeft/ArrowRight within the radios. Observe `eval "document.activeElement?.outerHTML"` only on synthetic controls: focus stays inside the dialog and arrow selection still holds focus after saving. Close and require focus on the Settings trigger. At a 760 × 480 content viewport and default size, capture both themes, positive dialog bounds, reachable Close and no document overflow. Press Escape while compact session reading is open: only Settings closes; the selected reading pane stays visible. Expand a synthetic long message and scroll each pane before opening Settings; compare the same nodes, scroll offsets and disclosures after closing it.
- **Unread (`settings-unread`).** Select Fixture Codex complete while running, open Settings, then run `node scripts/fixture/index.mjs simulate <copied-home> codex-complete`. Read-only `eval "window.agentpeek.getSnapshot().then(s=>s.sessions.filter(x=>x.summary.title==='Fixture Codex complete').map(x=>({key:x.key, attention:x.attention})))"` must report a new reply while Settings remains open. Save ARIA/PNG plus the disabled Session menu. Escape returns to the same reading target, which can then acknowledge the reply while focused. Repeat with two panes and confirm the inactive pane stays unread.
- **Persistence and recovery (`settings-persistence`, `settings-recovery`).** With launch approval and a matching built checkout, run `npm run e2e -- e2e/settings.spec.mjs --output <new-evidence-dir>`. Use a fresh path for this invocation; Playwright clears its selected output directory before running. It changes appearance through the real controls, injects a temporary failed-save condition only in its owned synthetic profile, checks rollback/retry and starts a second process after a clean exit on that same profile. Retain its PNG/ARIA, evidence.json and cleanup result beneath the chosen directory. `relaunch` in the helper only tests a concurrent second instance; it does not prove cold-start persistence. Unit tests cover malformed/missing preferences and failed-load retry; do not call those live UI evidence.
- **Cleanup.** Restore System through its radio, close Settings, run `doctor`, `focus`, and the observed App menu's Quit command. Require `wait-exit --timeout 3000` to report `cleanExit: true`, then `stop` for scratch/process/port cleanup. Remove the generator-owned original fixture separately.

## Gotchas

- Settings is modal: the main workspace is inert and intentionally absent from its accessible tree. Inspect only current visible controls; do not force clicks behind the dialog.
- Apply theme changes through the radios. Setting nativeTheme through main-eval bypasses this feature and cannot prove selection, persistence or recovery.
- A save failure rolls back both the selected radio and applied appearance. Choosing the desired theme again retries; Close does not cancel a save already in progress.
- System-theme observations prove the current Mac appearance and removal of the app override, not physical delivery of an OS appearance change. VoiceOver speech and packaged-window drawing need separate evidence.
- The helper's menu action proves wiring and accelerator registration, not physical Command-comma delivery. Native HTML modal behavior needs built-app checks; jsdom shims cannot prove focus trapping or Escape dispatch.
