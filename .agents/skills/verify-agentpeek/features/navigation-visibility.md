# Navigation visibility

Views collapses to an icon rail independently of the session list. Hide Sessions and Show Sessions preserve reading selections, scroll, disclosures and column preferences. Capacity follows the space left by navigation, so the rail can reveal a second reading pane at the minimum window size.

## Sub-features

- `navigation-views`: expanded Views and a 56-pixel icon rail, selected view, Active badge and source identity/status.
- `navigation-sessions`: separate list hiding, persistent restore control and retained reading state.
- `navigation-filter`: a rail view or native View command reveals the filtered list without replacing reading sessions.
- `navigation-capacity`: remaining width determines one/two reading panes and adjacent/replacement navigation.
- `navigation-keyboard`: Shift-Command-B/L, focus leaving hidden content and keyboard source details.

## How to get to it (user POV)

- Click Views in the top navigation controls, or press Shift-Command-B.
- Select a session, then click Hide Sessions / Show Sessions or press Shift-Command-L.
- In the rail, click Active, Pinned or All Sessions, or use View's existing commands.
- Click a source initial (C for Codex, A for Claude Code), then Close or Escape to dismiss its health details.
- Resize the window or expanded sidebar while reading one or two sessions.

## Driving it with agentpeek.mjs

Preconditions:

- User approval covers this task's synthetic launches. Launch a populated generator fixture as described in fixture-regression.md and require `doctor` to pass.
- Open two distinct synthetic sessions at 1440 content pixels through the row/context or drag paths in session-detail.md.

- **Independent toggles (`navigation-views`, `navigation-sessions`).** Save `aria navigation-expanded` and `screenshot navigation-expanded`. Expand a long reply, scroll its Recent messages region and the list, then save offsets and observed column widths through read-only `eval`. Run `click --role button --name "Hide Sessions"`, `click --role button --name "Collapse Views"`, and capture `navigation-rail-reading` ARIA/PNG. Both titles remain, list is hidden, Views is a 56-pixel rail with no Sidebar width separator, and Show Sessions remains reachable. Run `click --role button --name "Show Sessions"`: list returns without expanding Views. Run `click --role button --name "Expand Views"`: the preferred sidebar width returns. Compare transcript nodes, offsets, disclosures and active title before/after.
- **Filtered list (`navigation-filter`).** Hide Sessions while both panes fit. Collapse Views, then click the exact observed Pinned button name. List returns with pinned rows only, while both reading selections remain. Repeat with native `menu-click "View > All Sessions"`. Verify source/attention updates still appear while the list is hidden; fixture updates must not acknowledge an inactive reply.
- **Capacity (`navigation-capacity`).** With default expanded sidebar, visit content widths 799/800 (one-detail/list boundary), 839/840 (two-detail boundary) and 1124/1125 (list plus two-detail boundary). Save ARIA/PNG and zero document overflow. At 760 with two selections, expanded Views shows one detail with title radios. Collapse Views: both details fit, radios disappear and list remains hidden. Show Sessions replaces both details; resize to 1440 while browsing and verify details remain hidden until Hide Sessions restores them. With the rail, test 981/982 for list plus both details. Resize the expanded Sidebar width, then confirm thresholds follow the reserved width and preferred widths return when space permits. Repeat representative minimum/default/wide sizes in forced app Light/Dark and restore system appearance.
- **Keyboard (`navigation-keyboard`).** Focus the visible list, run `key Meta+Shift+L`: list hides and focus leaves it for the retained detail. Run `key Meta+Shift+B`: rail appears. Tab to the named source control, press Return to show details, then Escape: details close, source control regains focus and session navigation is unchanged. Reopen and use its Close button. Verify named status includes source name and state; errors have an exclamation mark as well as color. With no session selected, Hide Sessions is disabled and the list remains available.
- **Cleanup.** Run `doctor`, focus and choose `menu-click "Electron > Quit"` using the actual observed menu name, then `wait-exit --timeout 3000`. Require `cleanExit: true`, then run `stop` and retain artifacts. Clean the generator-owned original fixture separately.

## Gotchas

- Widths are renderer content pixels. Default expanded sidebar is 190 pixels; resized preferences shift capacity boundaries. The icon rail is fixed at 56 pixels and has no draggable sidebar divider.
- Show Sessions replaces reading only when the list cannot fit alongside the required detail panes. Hide Sessions then restores the remembered pane and keeps the list hidden on later enlargement.
- View changes retain reading selections but clear the list cursor, so a filtered-out reading session is not inserted into the filtered list.
- Visibility and preferred dimensions reset on quit/reload. Pins and read markers retain their existing persistence.
- Component tests do not prove native key delivery, actual geometry, theme drawing or source-disclosure accessibility. Report missing live steps as unverified.
