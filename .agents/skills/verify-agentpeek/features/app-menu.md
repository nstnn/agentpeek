# Application menu

AgentPeek has five native menus: AgentPeek, Edit, View, Session, and Window. View offers Active, Inbox, Pinned, All Sessions, enabled Reload Sessions, Zoom In, Zoom Out, Actual Size and the current zoom percentage, plus developer tools in development only. Zoom steps, shortcuts and persistence follow zoom.md. Session actions use the active visible session. Open to the Right creates split; Open in Left Pane / Open in Right Pane replace explicit slots; Close Right Pane remains available during browsing and source loss. Back returns from replacement reading to the shared list in both single and split navigation.

## Sub-features

- `menu-structure` lists About, Settings… (Command-comma), Quit (Command-Q), Copy (Command-C), Select All (Command-A), Active/Inbox/Pinned/All Sessions (Command-1/2/3/4), Reload Sessions (Command-R), Zoom In (Command-Plus), Zoom Out (Command-Minus), Actual Size (Command-0) and the disabled `Zoom: N%` label; Session: Open to the Right (or Open in Left Pane / Open in Right Pane in split), Open Codex or Open Claude (Command-O), Mark Read (Shift-Command-U), Pin or Unpin (Shift-Command-P), Copy Session ID (Option-Command-C), Close Right Pane and Back (Command-[); Window: Minimize (Command-M), Zoom, Close Window (Command-W) and Bring All to Front. Developer tools (Option-Command-I) appear only in development. Settings entry and modal behavior follow settings.md.
- `menu-reload` refreshes sessions through the enabled Reload Sessions item.
- `menu-open-codex` opens the active visible Codex chat by thread ID; the row context action uses its own row even when another chat is selected. Open Claude retains app activation.
- `menu-session-unselected` disables source actions and placement actions without an active visible source target.
- `menu-secondary` sends explicit-key placement and close events; Close depends on split presence independently of source availability.
- `menu-back` follows actual replacement-detail navigation including unavailable content, independently of width and source target.
- `menu-select-all` selects all of the window's text.
- `menu-copy` copies the selected text to the clipboard.
- `menu-about` opens the standard About panel with AgentPeek and the version from `package.json`.
- `menu-devtools` opens the developer tools in development builds, and is absent in packaged builds.

## How to get to it (user POV)

- Click a menu in the menu bar while AgentPeek is the active app, then click an item.
- Press the item's keyboard shortcut while AgentPeek's window is focused.

## Driving it with agentpeek.mjs

Preconditions:

- A fresh run from `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs launch --label app-menu`, and `doctor` prints `doctor: OK`.
- The window is focused: `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs focus` prints `"windowFocused": true`.
- For default capacity checks, choose View > Actual Size, expand Views and reset the observed Sidebar width divider; confirm 100% zoom and 190 pixels. Focus before resizing, read the actual content width and capture only after the layout settles. See the [capacity table](./README.md) for default thresholds.

- **Structure.** Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs menu app-menu-structure`. The five menus and shortcuts match `menu-structure`; Reload Sessions is enabled. Session items are disabled with no selection. Save `screenshot app-menu-initial` for the accompanying list interface.
- **Reload.** Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs menu-click "View > Reload Sessions"`. The result is `clicked: true` via its click handler. Follow the snapshot-timestamp and count checks in `sessions-connection.md`.
- **Open Codex (`menu-open-codex`).** With approval for external activation, select a synthetic Codex row and capture menu/ARIA/PNG. `menu-click "Session > Open Codex"` uses that thread ID; the menu registers Command-O. Change the selected chat and repeat, then right-click another row and choose Open Codex: it targets that row without changing the reading target. For synthetic-only runs, an isolated Electron test may record the OS handoff; report that limit explicitly. Physical Command-O and native popup dispatch require authorized native input. Actual Codex navigation requires separate real-session consent and no saved conversation captures.
- **View commands.** Read-only observation may subscribe with `eval "window.observedCommands = []; window.stopObservingCommands = window.agentpeek.onCommand(c => window.observedCommands.push(c)); true"`. Choose Active, Inbox, Pinned, and All Sessions with `menu-click`, then read `eval "window.observedCommands"`: `view:active`, `view:inbox`, `view:pinned`, `view:all`, in order. Finish with `eval "window.stopObservingCommands(); true"`. Also capture the heading after each command; it changes to Active, Inbox, Pinned and All Sessions. This observer alone proves event delivery.
- **Pane placement (`menu-secondary`).** At 1440 × 900 choose a synthetic row and run `menu-click "Session > Open to the Right"`. Right displays that key and becomes active; Close Right Pane is enabled. Choose another row: Right changes while Left stays. Activate Left, then choose another row: Left changes. The split Session menu offers Open in Left Pane / Open in Right Pane before other actions. Both use the active visible key; row popup counterparts bind the explicit row key. Verify Pin/Unpin on each active pane and restore pins. View > All Sessions clears the list cursor while preserving both panes in browsing; Close remains enabled, including source loss. `menu-click "Session > Close Right Pane"` returns to single and disables itself. Capture menu/ARIA/PNG for transitions. Verify native popup labels and selection separately with authorized desktop control; controller tests alone do not prove popup drawing.
- **Back (`menu-back`).** At minimum size, arrows select while browsing: hidden detail actions and Back stay disabled. Click/Return opens detail and enables Back. Capture menu/ARIA/PNG; Session > Back returns to the selected row. Repeat with a hidden synthetic source and Reload Sessions: Back stays available for unavailable replacement content. Open Second and test reading at 1124/1125 content pixels with default expanded Views, then 985/986 with the rail. Back is enabled while reading replaces navigation and disabled when the list can fit beside both details. At each width, clear any explicit hidden-list preference with Show Sessions, then reactivate a session row with click/Return if browsing replaced reading before asserting the result; retained browsing or Hide Sessions can otherwise mask capacity. Show Sessions disables detail actions only when it replaces reading with browsing; with both details still visible, their active actions remain available. Close Right Pane stays enabled in either state. Return to Sessions restores the remembered target, including after resizing while browsing.
- **Select All.** Run `menu-click "Edit > Select All"`, then `eval "String(window.getSelection())"` and `screenshot app-menu-select-all`. The selection includes the fixture banner, sidebar, list heading, and current list content.
- **Copy.** Only with the user's OK, because it replaces their clipboard. After Select All, run `menu-click "Edit > Copy"`, then `main-eval "electron.clipboard.readText()"`. The clipboard holds the same synthetic page text that was selected.
- **About.** Choose AgentPeek > About AgentPeek. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs menu-click "AgentPeek > About AgentPeek"`. The click reports `"via": "orderFrontStandardAboutPanel:"`. The panel is native, so seeing it needs the user or a desktop-control tool; report it as unverified otherwise.
- **Developer tools.** Choose View > Toggle Developer Tools. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs menu-click "View > Toggle Developer Tools"`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs main-eval "BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened()"`. Opening is asynchronous: repeat this read-only check for up to three seconds before treating `false` as a failure. The click reports `"via": "click handler"` and the settled check is `true`. Focus the app and choose the item again; the settled check becomes `false`.

## Gotchas

- The menu bar draws the first menu as `Electron` in unpackaged builds, because macOS names it after the app bundle. `menu` and `menu-click` use the menu's own label, `AgentPeek`.
- `key Meta+R` or `key Meta+W` never reaches the native menu. The `menu` listing proves accelerator registration and `menu-click` proves the action's wiring. Actual shortcut dispatch needs native keyboard input; report it separately.
- `menu` lists a second, hidden Zoom In with Command-= (`#zoom-in-equals`). It is the same command on another key, not a duplicate to report.
- Mark Read is enabled only when the active session has a new reply or an error, not for every selection.
- `menu-click` refuses to act unless the window is focused, as a real menu choice needs AgentPeek active. `focus` takes focus from the user's app.
- The About panel takes focus from the window. Run `focus` before the next `menu-click`.
- Toggle Developer Tools can take focus too. Run `focus` before choosing it again to close the tools.
- Copy replaces the user's clipboard. Never read the clipboard before copying: it may hold the user's private text, and `main-eval` results go into `actions.jsonl`.
- Verify the absence of Toggle Developer Tools in the existing packaged build through local-package.md; the helper's unpackaged menu cannot prove it.
- Select rows through the list (see sessions-list.md), then verify the active visible target and enabled Session actions. Do not manufacture selection through eval. Detail buttons and narrow Back are covered in session-detail.md.
