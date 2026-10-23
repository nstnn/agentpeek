# Navigation visibility

An icon left of the Sessions heading collapses navigation to an icon rail independently of the session list. The Sessions title itself is not interactive. An icon beside Active/Pinned/All Sessions hides the list; a restore icon appears in the reading header while it is hidden. Controls use the existing headers, with accessible names/tooltips and no extra toolbar or text labels. Toggles preserve reading selections, scroll, disclosures and column preferences. Capacity follows the space left by navigation.

## Sub-features

- `navigation-views`: expanded Views and a 56-pixel icon rail, selected view, Active badge and source identity/status.
- `navigation-sessions`: separate list hiding, persistent restore control and retained reading state.
- `navigation-filter`: a rail view or native View command reveals the filtered list without replacing reading sessions.
- `navigation-capacity`: remaining width determines one/two reading panes and adjacent/replacement navigation.
- `navigation-keyboard`: Shift-Command-B/L, focus leaving hidden content and keyboard source details.
- `navigation-motion`: 220 ms decelerating column transitions, stable clipped text, immediate reversal and Reduce Motion.

## How to get to it (user POV)

- Click the icon left of Sessions to collapse navigation; click its rail icon to expand it, or press Shift-Command-B. Clicking the Sessions title does nothing.
- Select a session, then click the icon beside Active/Pinned/All Sessions to hide the list. Click the restore icon in the reading header to show it again, or press Shift-Command-L. Accessible names remain Hide Sessions / Show Sessions.
- In the rail, click Active, Pinned or All Sessions, or use View's existing commands.
- Click a source initial (C for Codex, A for Claude Code), then Close or Escape to dismiss its health details.
- Resize the window or expanded sidebar while reading one or two sessions.
- Toggle again during a transition to reverse it. With macOS Reduce Motion enabled, navigation changes immediately.

## Driving it with agentpeek.mjs

Preconditions:

- User approval covers this task's synthetic launches. Launch a populated generator fixture as described in fixture-regression.md and require `doctor` to pass.
- Open two distinct synthetic sessions at 1440 content pixels through the row/context or drag paths in session-detail.md.
- For the named capacity boundaries, choose View > Actual Size, expand Views and reset the observed Sidebar width divider with Enter or a double-click. Confirm 100% zoom and 190-pixel Sidebar width. Use focused `main-eval "BrowserWindow.getAllWindows()[0].setContentSize(<width>, 720)"`, then observe `innerWidth` and settled visibility before capture; custom sidebar widths move the boundaries.

- **Independent toggles (`navigation-views`, `navigation-sessions`).** Save `aria navigation-expanded` and `screenshot navigation-expanded`. Expand a long reply, scroll its Recent messages region and the list, then save offsets and observed column widths through read-only `eval`. Run `click --role button --name "Hide Sessions"`, `click --role button --name "Collapse Views"`, and capture `navigation-rail-reading` ARIA/PNG. Both titles remain, list is hidden, Views is a 56-pixel rail with no Sidebar width separator, and Show Sessions remains reachable. Run `click --role button --name "Show Sessions"`: list returns without expanding Views. Run `click --role button --name "Expand Views"`: the preferred sidebar width returns. Compare transcript nodes, offsets, disclosures and active title before/after.
- **Filtered list (`navigation-filter`).** Hide Sessions while both panes fit. Collapse Views, then click the exact observed Pinned button name. List returns with pinned rows only, while both reading selections remain. Repeat with native `menu-click "View > All Sessions"`. Verify source/attention updates still appear while the list is hidden; fixture updates must not acknowledge an inactive reply.
- **Capacity (`navigation-capacity`).** With one selection and default expanded Views, visit content widths 799/800; with two selections visit 839/840 and 1124/1125. Save ARIA/PNG and zero document overflow. Start each boundary observation in reading with the list available when capacity permits: use Show Sessions to clear an explicit hidden-list preference, then reactivate a session row with click/Return if replacement browsing hid the details. At 760 with two selections, expanded Views shows one detail with title radios. Collapse Views: both details fit, radios disappear and list remains hidden. Show Sessions replaces both details; resize to 1440 while browsing and verify details remain hidden until Hide Sessions restores them. With the rail, test 985/986: at each width, start in reading and choose Show Sessions; 985 replaces details with the list, while 986 can show the list alongside both details. Resume reading before the next observation so retained browsing does not mask the boundary. Resize the expanded Sidebar width, then confirm thresholds follow the reserved width and preferred widths return when space permits. Repeat representative minimum/default/wide sizes in forced app Light/Dark and restore the recorded app theme source.
- **Keyboard (`navigation-keyboard`).** Focus the visible list, run `key Meta+Shift+L`: list hides and focus leaves it for the retained detail. Run `key Meta+Shift+B`: rail appears. Tab to the named source control, press Return to show details, then Escape: details close, source control regains focus and session navigation is unchanged. Reopen and use its Close button. Verify named status includes source name and state; errors have an exclamation mark as well as color. With no session selected, Hide Sessions is disabled and the list remains available.
- **Empty-list focus (`navigation-keyboard`).** Create a fresh fixture omitting Claude with `node scripts/fixture/index.mjs create claude`. Before selecting a session, drag an observed Codex row directly to Right using the path in session-detail.md. Select the Codex tool filter, then run `node scripts/fixture/index.mjs simulate <copied-home> missing-codex` and native `menu-click "View > Reload Sessions"`. Close Right Pane. With no rows or reading selection, Hide Sessions is disabled and keyboard focus lands on the selected Codex filter, rather than the page body or disabled control.
- **Motion (`navigation-motion`).** At minimum/default/wide sizes, run `motion --selector '[data-navigation-control="sessions"]' --name motion-sessions` and `motion --selector '.sidebar-heading-toggle' --name motion-views`. Record intermediate and settled geometry and compositor frames over 500 ms. Columns should decelerate together over 220 ms without stretching text, exposing horizontal overflow or resetting reading state. Add `--repeat-after 60`: motion reverses from its current position and leaves no exiting regions or animations after settling. Add `--drag-divider '.pane-divider[aria-label="Sidebar width"]'` or `--resize-width 1100` to interrupt motion with a real divider drag or an isolated native window resize at about 80 ms: columns settle immediately, with resizing following input. Use `--reduced-motion reduce`, repeat both toggles and require zero running animations; `--reduce-after 60` checks cancellation during motion. Chromium preference overrides are cleared after each capture and do not prove delivery of the macOS system preference.
- **Cleanup.** Run `doctor`, `focus` and choose `menu-click "AgentPeek > Quit AgentPeek"` using the labels from `menu`, then `wait-exit --timeout 3000`. Require `cleanExit: true`, then run `stop` and retain artifacts. Clean the generator-owned original fixture separately.

## Gotchas

- Widths are renderer content pixels. Default expanded sidebar is 190 pixels; resized preferences shift capacity boundaries. The icon rail is fixed at 56 pixels and has no draggable sidebar divider.
- Show Sessions replaces reading only when the list cannot fit alongside the required detail panes. Hide Sessions then restores the remembered pane and keeps the list hidden on later enlargement.
- View changes retain reading selections but clear the list cursor, so a filtered-out reading session is not inserted into the filtered list.
- Visibility and preferred dimensions reset on quit/reload. Pins and read markers retain their existing persistence.
- The list restore icon occurs once in the visible reading headers; using it must not activate a different pane. Restoring the list transfers focus into that list. The compact pane selector remains available only when needed.
- Component tests do not prove native key delivery, actual geometry, theme drawing or source-disclosure accessibility. Report missing live steps as unverified.
- Outgoing content becomes inert and inaccessible immediately while its edge finishes moving. Hidden panes cannot request or acknowledge messages during the visual exit. Motion is renderer-local; no preference is persisted.
