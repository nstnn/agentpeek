# Application menu

AgentPeek has five native menus: AgentPeek, Edit, View, Session, and Window. View offers Active, Pinned, All Sessions, and enabled Reload Sessions, plus developer tools in development only. Session acts on the selected session; its actions are disabled when no row is selected.

## Sub-features

- `menu-structure` lists About, Quit (Command-Q), Copy (Command-C), Select All (Command-A), Active/Pinned/All Sessions (Command-1/2/3), Reload Sessions (Command-R), the Session actions, and the existing Window items. Developer tools (Option-Command-I) appear only in development.
- `menu-reload` refreshes sessions through the enabled Reload Sessions item.
- `menu-session-unselected` disables Open Codex, Mark Read, Pin, Copy Session ID, and Back when no session is selected.
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
- **Select All.** Run `menu-click "Edit > Select All"`, then `eval "String(window.getSelection())"` and `screenshot app-menu-select-all`. The selection includes the fixture banner, sidebar, list heading, and current list content.
- **Copy.** Only with the user's OK, because it replaces their clipboard. After Select All, run `menu-click "Edit > Copy"`, then `main-eval "electron.clipboard.readText()"`. The clipboard holds the same synthetic page text that was selected.
- **About.** Choose AgentPeek > About AgentPeek. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs menu-click "AgentPeek > About AgentPeek"`. The click reports `"via": "orderFrontStandardAboutPanel:"`. The panel is native, so seeing it needs the user or a desktop-control tool; report it as unverified otherwise.
- **Developer tools.** Choose View > Toggle Developer Tools. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs menu-click "View > Toggle Developer Tools"`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs main-eval "BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened()"`. The click reports `"via": "click handler"` and the check is `true`. Choose the item again to close them.

## Gotchas

- The menu bar draws the first menu as `Electron` in unpackaged builds, because macOS names it after the app bundle. `menu` and `menu-click` use the menu's own label, `AgentPeek`.
- `key Meta+R` or `key Meta+W` never reaches the native menu. Shortcuts are proven by the accelerators in the `menu` listing plus `menu-click`, not by pressing keys.
- `menu-click` refuses to act unless the window is focused, as a real menu choice needs AgentPeek active. `focus` takes focus from the user's app.
- The About panel takes focus from the window. Run `focus` before the next `menu-click`.
- Toggle Developer Tools can take focus too. Run `focus` before choosing it again to close the tools.
- Copy replaces the user's clipboard. Never read the clipboard before copying: it may hold the user's private text, and `main-eval` results go into `actions.jsonl`.
- That Toggle Developer Tools is absent from packaged builds can only be verified once a packaged build exists.
- Select rows through the list (see sessions-list.md), then verify the selected target and enabled Session actions. Do not manufacture selection through eval. Detail buttons and narrow Back are covered in session-detail.md.
