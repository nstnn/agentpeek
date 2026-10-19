# Main window

Opening AgentPeek shows one window titled AgentPeek with a sidebar, sessions list, and the selected session detail at widths of at least 1000 points. Fixture runs also show a persistent banner naming the synthetic home. The window opens at a fixed default size, cannot be made smaller than a minimum size, and follows the Mac's Light or Dark appearance.

## Sub-features

- `window-open` shows exactly one window, titled AgentPeek, once its content has rendered.
- `window-layout` shows Active and source health; an empty synthetic home says "No sessions yet".
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
- **Layout.** Look at the window. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs aria main-window-initial` and `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs screenshot main-window-initial`. The tree holds `main "Sessions"`, `heading "Active" [level=1]`, sidebar view buttons and both sources. An empty home shows "No sessions yet". At the default width the detail placeholder says "No session selected".
- **Default size.** Check the size the window opened at. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs main-eval "BrowserWindow.getAllWindows()[0].getSize()"`. The result is `[1100, 720]`.
- **Smallest size.** Try to make the window smaller than allowed. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs main-eval "(BrowserWindow.getAllWindows()[0].setSize(400, 300), BrowserWindow.getAllWindows()[0].getSize())"`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs screenshot main-window-minimum`. The result is `[760, 480]`, and the screenshot shows a 170-point sidebar and list filling the remaining width; the detail is hidden. No horizontal page overflow or clipped controls.
- **Light appearance.** Force the light theme. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs main-eval "electron.nativeTheme.themeSource = 'light'"`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs eval "matchMedia('(prefers-color-scheme: dark)').matches"` and `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs screenshot main-window-light`. The media query is `false` and the screenshot shows dark text on a light background.
- **Dark appearance.** Force the dark theme. Run the same three commands with `'dark'` and the screenshot name `main-window-dark`. The media query is `true` and the screenshot shows light text on a dark background.
- **Restore.** Return to the system theme. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs main-eval "electron.nativeTheme.themeSource = 'system'"`. The result is `"system"`.

## Gotchas

- Screenshots cover the page only, not the title bar. The 720-point window height includes a 32-point title bar, so the page is 1100 × 688 points, and on a Retina display the PNG is 2200 × 1376 pixels.
- Do not assert the window's position. macOS places it, and it differs between runs.
- `setSize` stands in for dragging a corner, which this harness cannot do. It proves the minimum size and the layout at that size, not the drag itself.
- Never change the Mac's appearance setting. The `nativeTheme.themeSource` override is AgentPeek's own and ends when the app quits, but restore it before driving other features in the same run.
- At widths of at least 1000 points, the sidebar is 190 points and list 420 points. Below that, sidebar is 170 points and detail is hidden. Click or Return opens detail in place with Back; see session-detail.md.
