# Main window

Opening AgentPeek shows one window titled AgentPeek with a centered heading and live session count. Fixture runs also show a persistent banner naming the synthetic home. The window opens at a fixed default size, cannot be made smaller than a minimum size, and follows the Mac's Light or Dark appearance.

## Sub-features

- `window-open` shows exactly one window, titled AgentPeek, once its content has rendered.
- `window-placeholder` shows the heading "AgentPeek" and "0 sessions" for the empty synthetic home (or the fixture's actual session count).
- `window-size` opens at 1100 × 720 points and refuses to shrink below 760 × 480.
- `window-appearance` uses system colors, so the page is light in Light mode and dark in Dark mode.

## How to get to it (user POV)

- Open AgentPeek. In development that is `npm start` after `npm run build`, or `npm run dev`; a packaged build does not exist yet.
- Drag a window corner to resize it.
- Switch the Mac between Light and Dark appearance in System Settings.

## Driving it with agentpeek.mjs

Preconditions:

- The user approved launching AgentPeek for this task.
- No earlier step in this run changed the window's size or theme.

- **Open.** Launch AgentPeek. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs launch --label main-window`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs doctor`. Launch prints a run id, and doctor prints `doctor: OK` with `one visible window: [{"visible":true,"title":"AgentPeek"}]`.
- **Placeholder.** Look at the window. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs aria main-window-initial` and `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs screenshot main-window-initial`. The tree holds `main`, `heading "AgentPeek" [level=1]`, and `StaticText "0 sessions"` for an empty home. The screenshot shows the heading and count centered, with the fixture banner above.
- **Default size.** Check the size the window opened at. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs main-eval "BrowserWindow.getAllWindows()[0].getSize()"`. The result is `[1100, 720]`.
- **Smallest size.** Try to make the window smaller than allowed. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs main-eval "(BrowserWindow.getAllWindows()[0].setSize(400, 300), BrowserWindow.getAllWindows()[0].getSize())"`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs screenshot main-window-minimum`. The result is `[760, 480]`, and the screenshot still shows both placeholder lines in full.
- **Light appearance.** Force the light theme. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs main-eval "electron.nativeTheme.themeSource = 'light'"`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs eval "matchMedia('(prefers-color-scheme: dark)').matches"` and `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs screenshot main-window-light`. The media query is `false` and the screenshot shows dark text on a light background.
- **Dark appearance.** Force the dark theme. Run the same three commands with `'dark'` and the screenshot name `main-window-dark`. The media query is `true` and the screenshot shows light text on a dark background.
- **Restore.** Return to the system theme. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs main-eval "electron.nativeTheme.themeSource = 'system'"`. The result is `"system"`.

## Gotchas

- Screenshots cover the page only, not the title bar. The 720-point window height includes a 32-point title bar, so the page is 1100 × 688 points, and on a Retina display the PNG is 2200 × 1376 pixels.
- Do not assert the window's position. macOS places it, and it differs between runs.
- `setSize` stands in for dragging a corner, which this harness cannot do. It proves the minimum size and the layout at that size, not the drag itself.
- Never change the Mac's appearance setting. The `nativeTheme.themeSource` override is AgentPeek's own and ends when the app quits, but restore it before driving other features in the same run.
- The placeholder goes away when the session interface lands. Rewrite this file in that change.
