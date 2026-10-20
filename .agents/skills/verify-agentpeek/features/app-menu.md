# Application menu

AgentPeek has five native menus: AgentPeek, Edit, View, Session, and Window. View offers Active, Pinned, All Sessions, and enabled Reload Sessions, plus developer tools in development only. Session actions use the active visible session. Open in Second Pane opens/replaces a retained Second selection; Close Second Pane remains available during browsing and source loss. Back returns from replacement reading to the shared list in both single and split navigation.

## Sub-features

- `menu-structure` lists About, Quit (Command-Q), Copy (Command-C), Select All (Command-A), Active/Pinned/All Sessions (Command-1/2/3), Reload Sessions (Command-R), the Session actions, and the existing Window items. Developer tools (Option-Command-I) appear only in development.
- `menu-reload` refreshes sessions through the enabled Reload Sessions item.
- `menu-session-unselected` disables source actions and Open in Second Pane without an active visible source target.
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

- **Structure.** Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs menu app-menu-structure`. The five menus and shortcuts match `menu-structure`; Reload Sessions is enabled. Session items are disabled with no selection. Save `screenshot app-menu-initial` for the accompanying list interface.
- **Reload.** Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs menu-click "View > Reload Sessions"`. The result is `clicked: true` via its click handler. Follow the snapshot-timestamp and count checks in `sessions-connection.md`.
- **View commands.** Read-only observation may subscribe with `eval "window.observedCommands = []; window.stopObservingCommands = window.agentpeek.onCommand(c => window.observedCommands.push(c)); true"`. Choose Active, Pinned, and All Sessions with `menu-click`, then read `eval "window.observedCommands"`: `view:active`, `view:pinned`, `view:all`, in order. Finish with `eval "window.stopObservingCommands(); true"`. Also capture the heading after each command; it changes to Active, Pinned and All Sessions. This observer alone proves event delivery.
- **Second selection (`menu-secondary`).** At 1440 × 900 content size select a synthetic row; capture menu/ARIA/PNG before and after `menu-click "Session > Open in Second Pane"`. Second displays that key and becomes active; Close is enabled. Choose a different row: Main changes and Second stays. Click Second's Recent messages and choose Session > Pin; only Second pins. Tab into a Main control and choose Session > Pin; only Main pins. Restore both pins. View > All Sessions clears Main but retains Second; Close stays enabled during source loss. Close Second Pane returns to single and disables itself. Capture menu/ARIA/PNG for each transition. Exact popup dispatch and late callbacks have controller tests; native popup pixels are outside the helper.
- **Back (`menu-back`).** At minimum size, arrows select while browsing: hidden detail actions and Back stay disabled. Click/Return opens detail and enables Back. Capture menu/ARIA/PNG; Session > Back returns to the selected row. Repeat with a hidden synthetic source and Reload Sessions: Back stays available for unavailable replacement content. Open Second and repeat at 999, 1000, 1299 and 1300 content pixels: Back is enabled only while reading replaces navigation (below 1300), and disabled while browsing or reading at 1300+. Show Sessions disables detail actions but keeps Close Second Pane enabled. Return to Sessions restores the remembered target, including after resizing while browsing.
- **Select All.** Run `menu-click "Edit > Select All"`, then `eval "String(window.getSelection())"` and `screenshot app-menu-select-all`. The selection includes the fixture banner, sidebar, list heading, and current list content.
- **Copy.** Only with the user's OK, because it replaces their clipboard. After Select All, run `menu-click "Edit > Copy"`, then `main-eval "electron.clipboard.readText()"`. The clipboard holds the same synthetic page text that was selected.
- **About.** Choose AgentPeek > About AgentPeek. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs menu-click "AgentPeek > About AgentPeek"`. The click reports `"via": "orderFrontStandardAboutPanel:"`. The panel is native, so seeing it needs the user or a desktop-control tool; report it as unverified otherwise.
- **Developer tools.** Choose View > Toggle Developer Tools. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs menu-click "View > Toggle Developer Tools"`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs main-eval "BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened()"`. Opening is asynchronous: repeat this read-only check for up to three seconds before treating `false` as a failure. The click reports `"via": "click handler"` and the settled check is `true`. Focus the app and choose the item again; the settled check becomes `false`.

## Gotchas

- The menu bar draws the first menu as `Electron` in unpackaged builds, because macOS names it after the app bundle. `menu` and `menu-click` use the menu's own label, `AgentPeek`.
- `key Meta+R` or `key Meta+W` never reaches the native menu. The `menu` listing proves accelerator registration and `menu-click` proves the action's wiring. Actual shortcut dispatch needs native keyboard input; report it separately.
- `menu-click` refuses to act unless the window is focused, as a real menu choice needs AgentPeek active. `focus` takes focus from the user's app.
- The About panel takes focus from the window. Run `focus` before the next `menu-click`.
- Toggle Developer Tools can take focus too. Run `focus` before choosing it again to close the tools.
- Copy replaces the user's clipboard. Never read the clipboard before copying: it may hold the user's private text, and `main-eval` results go into `actions.jsonl`.
- Verify the absence of Toggle Developer Tools in the existing packaged build through local-package.md; the helper's unpackaged menu cannot prove it.
- Select rows through the list (see sessions-list.md), then verify the active visible target and enabled Session actions. Do not manufacture selection through eval. Detail buttons and narrow Back are covered in session-detail.md.
