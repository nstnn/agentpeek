# Sessions list

The window opens in Active with tool health, attention groups and live counts. Pinned and All Sessions share the tool filter. Rows show titles, folders, labeled states, relative times and pins. Selection stays in its group and slot until another row or filter is chosen; updates do not take focus or move the visible selected row. Detail content and narrow activation/Back are not built yet.

## Sub-features

- `list-views` switches Active, Pinned and All Sessions through sidebar or View menu.
- `list-filter` filters every view by All, Codex or Claude Code, with live per-view counts.
- `list-groups` orders Waiting for you, Errors, New replies, Running and Unknown, with text status labels.
- `list-selection` starts unselected, supports arrows/Home/End, keeps selected rows through updates and supplies the Session menu target.
- `list-context` opens the native row menu by right-click or Shift+F10 and shows a gray row until dismissal.
- `list-health` shows both sources, first-launch copy, fixture/local-state warnings and filtered empty/error states.
- `list-time` refreshes relative times once a minute without re-sorting or moving focus.

## How to get to it (user POV)

- Open AgentPeek and select Active, Pinned or All Sessions in the sidebar or View menu (⌘1–⌘3).
- Choose a tool above the list. Tab enters the sidebar, then tool filter, then list; arrow keys choose within each control.
- Click a row or use Up/Down/Home/End in the list. Choose actions in the Session menu.
- Right-click/Control-click a row, or select it and press Shift+F10, for its context menu.
- Close the first-launch strip with its labeled × button. View > Reload Sessions retries source reads.

## Driving it with agentpeek.mjs

Preconditions:

- The user approved synthetic launches and focus/menu interaction for this task.
- Use an entirely synthetic home with recent sessions and known titles; include running Codex and waiting Claude Code sessions. Never copy real tool files. The existing format fixtures can supply synthetic record shapes, but their old timestamps need refreshing.
- `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs launch --label sessions-list --fixture <absolute-synthetic-home>` succeeded and `doctor` passes.
- Replace option names below with literal names from the current `aria` tree; relative times change with the clock.

- **Initial groups.** Run `aria sessions-list-initial` and `screenshot sessions-list-initial`. Active is current, both sources have health text, no option is selected, rows are grouped in the approved order, and the fixture banner names the copied home.
- **Views.** Run `menu-click "View > Pinned"`, then `aria sessions-list-pinned` and `screenshot sessions-list-pinned`. Without pins it says "No pinned sessions". Run `menu-click "View > All Sessions"` and capture `aria sessions-list-all` plus `screenshot sessions-list-all`; the footnote describes seven days and 50 sessions per tool.
- **Filter.** Read `aria`, then `click --role radio --name "Codex <count>"`. Capture `aria sessions-list-filter` and `screenshot sessions-list-filter`. Only Codex rows appear; sidebar totals are unchanged. The filter persists when changing views.
- **Keyboard.** With the list showing rows, click an option using its exact accessible name, then `key ArrowDown`, `key Home`, and `key End`. Capture `aria sessions-list-keyboard` plus `screenshot sessions-list-keyboard`. Exactly one option is selected, and `eval "({role: document.activeElement.getAttribute('role'), scroll: document.querySelector('[role=listbox]').scrollTop})"` reports listbox focus. Tab reaches one sidebar and one tool-filter stop, with arrows moving inside each.
- **Session actions.** Select a row, capture `menu sessions-list-selected`, then `menu-click "Session > Pin"`. Capture `aria sessions-list-pinned-row` and `screenshot sessions-list-pinned-row`; its option name includes "pinned", and Pinned's count changes. Mark Read is enabled only for an unread reply or error. With permission for that state change in the isolated profile, choose `menu-click "Session > Mark Read"` and capture the updated row/counts. Focused wide detail automatically marks the loaded reply/error read; use the narrow list to verify explicit Mark Read before opening detail.
- **Retained selection.** Select a running row, then append a synthetic completion to its copied rollout with the fixture writer. Observe `aria sessions-list-live-update` and `screenshot sessions-list-live-update`. The same option remains selected in its previous group/slot with current status; group/sidebar counts update. Read-only observation of listbox focus and scroll before/after must match. Choose another row: the retained row takes its current group/order or leaves Active.
- **Earlier groups change.** With a row selected, append a synthetic error in another session that adds a preceding group. Compare `eval "document.querySelector('[aria-selected=true]').getBoundingClientRect().top"` before and after, then save `aria sessions-list-anchor` and `screenshot sessions-list-anchor`. The selected ID/focus remain unchanged and its top differs by at most one display pixel. Repeat when the earlier error clears after a newer turn. Scroll offsets may compensate for the changed content.
- **Context entry.** Select an option, then `key Shift+F10`. Observe `eval "document.querySelector('.context-open')?.getAttribute('aria-selected')"`: true while the menu is open. The menu is native; rendering and mouse selection need a separately authorized desktop-control tool or the user. Dismiss with a real native Escape and confirm `.context-open` disappears. Component/main-process tests cover exact key dispatch and dismissal timing when the native surface is unavailable; do not claim native drawing from those tests.
- **Health and notices.** Empty launch shows "No sessions yet"; choosing a missing tool shows its installation copy. A fresh populated profile shows the first-launch strip; `click --role button --name "Dismiss first launch notice"` hides it for the run. Save before/after aria trees and screenshots. Unreadable/newer/unwritable state files and health recovery have synthetic component tests; claim runtime proof only when the corresponding file condition is actually exercised.
- **Cleanup.** Run `doctor`, `menu-click "Window > Close Window"`, `wait-exit --timeout 3000`, then `stop`. Record `clean: true` and `defaultProfileUnchanged: true`.

## Gotchas

- Counts describe live membership even while the selected row is retained; an old group may show count 0 until selection changes.
- When earlier content grows or shrinks, temporary blank space and the scroll offset keep the selected row at the same visible position. Selecting another row releases that space; user scrolling establishes a new anchor.
- Switching view or tool filter clears selection and restores normal grouping. A disappeared selected session remains visible; native actions are disabled because the main process rechecks the current source.
- Menu accelerators need native menu dispatch: `key Meta+1` does not reach the View menu through CDP.
- Native popup pixels/actions are outside this helper's reach. A page screenshot and a pending popup promise prove only the row's entry/highlight, not native menu rendering.
- Live updates have aria-live off. AX labels and keyboard behavior can be checked here; actual VoiceOver speech remains a separate platform check.
- See session-detail.md for transcript loading, focused read-on-view and narrow activation/Back.
