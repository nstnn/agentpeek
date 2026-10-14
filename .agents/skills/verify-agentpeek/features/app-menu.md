# Application menu

AgentPeek has a standard macOS menu bar with four menus. The first menu holds About and Quit, Edit holds Copy and Select All for the window's text, View holds Reload Sessions (shown but disabled until AgentPeek reads sessions) and, in development builds only, Toggle Developer Tools, and Window holds Minimize, Zoom, Close Window, and Bring All to Front.

## Sub-features

- `menu-structure` lists exactly these items with these shortcuts: About AgentPeek; Quit AgentPeek (Command-Q); Copy (Command-C); Select All (Command-A); Reload Sessions (Command-R); Toggle Developer Tools (Option-Command-I); Minimize (Command-M); Zoom; Close Window (Command-W); Bring All to Front.
- `menu-reload-disabled` shows Reload Sessions disabled, so neither the item nor Command-R does anything.
- `menu-select-all` selects all of the window's text.
- `menu-copy` copies the selected text to the clipboard.
- `menu-about` opens the standard About panel.
- `menu-devtools` opens the developer tools in development builds, and is absent in packaged builds.

## How to get to it (user POV)

- Click a menu in the menu bar while AgentPeek is the active app, then click an item.
- Press the item's keyboard shortcut while AgentPeek's window is focused.

## Driving it with agentpeek.mjs

Preconditions:

- A fresh run from `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs launch --label app-menu`, and `doctor` prints `doctor: OK`.
- The window is focused: `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs focus` prints `"windowFocused": true`.

- **Structure.** Open each menu and read it. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs menu app-menu-structure`. The listing matches `menu-structure`: menus `AgentPeek`, `Edit`, `View`, and `Window`, with `Reload Sessions [disabled] (CommandOrControl+R) #reload-sessions` under View and every other item enabled.
- **Reload Sessions is disabled.** Choose View > Reload Sessions. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs menu-click "View > Reload Sessions"`. The result is `{"clicked": false, "reason": "disabled"}` with exit code 1.
- **Select All.** Choose Edit > Select All. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs menu-click "Edit > Select All"`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs eval "String(window.getSelection())"` and `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs screenshot app-menu-select-all`. The click reports `"via": "selectAll:"`, the selection is `"AgentPeek\nNo sources connected yet"`, and the screenshot shows both lines highlighted.
- **Copy.** Only with the user's OK, because it replaces their clipboard. After Select All, choose Edit > Copy. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs menu-click "Edit > Copy"`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs main-eval "electron.clipboard.readText()"`. The click reports `"via": "copy:"` and the clipboard holds `"AgentPeek\nNo sources connected yet"`.
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
- When Reload Sessions starts working, or the Session menu lands, update `menu-structure` and replace the disabled check with a recipe for the working item.
