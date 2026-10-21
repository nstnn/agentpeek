# Main window

Opening AgentPeek shows one window titled AgentPeek with a sidebar, sessions list, and selected detail when navigation leaves enough content width. See navigation-visibility.md for independent toggles and current capacity boundaries. Fixture runs show a persistent banner naming the synthetic home. The window opens at a fixed default size, cannot shrink below its minimum, and follows the Mac's Light or Dark appearance.

## Sub-features

- `window-open` shows exactly one window, titled AgentPeek, once its content has rendered.
- `window-layout` shows Active and source health; an empty synthetic home says "No sessions yet".
- `window-size` opens at 1100 × 720 points and refuses to shrink below 760 × 480.
- `window-appearance` follows system appearance with paired Light and Dark palettes.
- `window-scrollbars` uses slim platform scrollbars with neutral thumbs and transparent tracks in both themes, including the list, both transcripts and horizontal Markdown overflow.
- `window-reading-space` bounds initial titles to two lines and keeps long-message controls usable across default/minimum sizes and capacity boundaries.
- `window-split-size` uses available width for one/two details and adjacent/replacement list navigation; navigation-visibility.md defines capacity boundaries for expanded Views and the icon rail.
- `window-pane-resize` trades space between adjacent visible columns with pointer/keyboard dividers, readable minimums, cancellation/reset, and in-memory sizes across responsive modes.

## How to get to it (user POV)

- Open AgentPeek. In development that is `npm start` after `npm run build`, or `npm run dev`; the local packaged build is `dist/mac-arm64/AgentPeek.app` (see local-package.md for isolated native checks).
- Drag a window corner to resize it.
- Switch the Mac between Light and Dark appearance in System Settings.
- Scroll the sessions list or a long conversation with the trackpad, mouse or keyboard; drag the scrollbar thumb to move through it.

## Driving it with agentpeek.mjs

Preconditions:

- The user approved launching AgentPeek for this task.
- No earlier step in this run changed the window's size or theme.

- **Open.** Launch AgentPeek. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs launch --label main-window`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs doctor`. Launch prints a run id, and doctor prints `doctor: OK` with `one visible window: [{"visible":true,"title":"AgentPeek"}]`.
- **Layout.** Look at the window. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs aria main-window-initial` and `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs screenshot main-window-initial`. The tree holds `main "Sessions"`, `heading "Active" [level=1]`, sidebar view buttons and both sources. An empty home shows "No sessions yet". At the default width the detail placeholder says "No session selected".
- **Default size.** Check the size the window opened at. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs main-eval "BrowserWindow.getAllWindows()[0].getSize()"`. The result is `[1100, 720]`.
- **Smallest size.** Try to make the window smaller than allowed. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs main-eval "(BrowserWindow.getAllWindows()[0].setSize(400, 300), BrowserWindow.getAllWindows()[0].getSize())"`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs screenshot main-window-minimum`. The result is `[760, 480]`, and the screenshot shows a 190-point sidebar and list filling the remaining width; the detail is hidden. No horizontal page overflow or clipped controls.
- **Layout boundary.** Follow navigation-visibility.md at expanded Views widths 799/800, 839/840 and 1124/1125, plus rail 981/982. Capture ARIA/PNG and zero document overflow. Resizing preserves the reading target; Show Sessions opens replacement navigation only when needed.
- **Light appearance.** Force the light theme. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs main-eval "electron.nativeTheme.themeSource = 'light'"`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs eval "matchMedia('(prefers-color-scheme: dark)').matches"` and `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs screenshot main-window-light`. The media query is `false` and the screenshot shows dark text on a light background.
- **Reading space.** Follow session-detail.md's `detail-title` and `detail-long-message` journeys at default/minimum and 799/800 content widths. Capture header/transcript heights and zero page overflow before and after expansion/collapse; fixture banners reduce usable reading height. In compact detail, Back/Escape still returns to the selected row with list focus.
- **Slim scrollbars (`window-scrollbars`).** Use a populated synthetic fixture with long conversations and horizontally overflowing code/table content. Run `focus` and confirm the page is visible before keyboard scrolling. In All Sessions, focus the list and run `key PageDown`; save `aria window-scrollbars-list` and `screenshot window-scrollbars-list`. Open two long synthetic conversations at 1440 content pixels using session-detail.md, click each observed Recent messages region in turn, then run `key Home`, `key PageDown` and `key End`. Save settled transcript offsets before/after with read-only `eval`, plus ARIA/PNG: each scrolls independently, its thumb is slim and rounded, and its track has no contrasting strip. Inspect `getComputedStyle(e).scrollbarWidth` and `getComputedStyle(e).scrollbarColor` on the list, visible transcripts and overflowing Markdown: width is `thin` and track is transparent. With authorized desktop control bound to the exact synthetic instance, drag a visible thumb and scroll an overflowing code/table area horizontally; record the changed offsets and no page overflow. Report those input paths untested if the exact instance cannot be targeted. Repeat representative scrolling at 760 × 480 and in forced app Light/Dark, saving ARIA/PNG. Check readable thumb contrast, reachable controls and the short keyboard focus cue. Restore the system theme after capture.
- **Split sizes (`window-split-size`).** Follow navigation-visibility.md with two long synthetic sessions at default/minimum and both sides of each capacity boundary. Capture both themes, positive transcript height, zero overflow, title selectors only when one detail fits, and retained scroll/disclosures. Closing either pane restores the other session. Restore system appearance.
- **Resize (`window-pane-resize`).** At 1440 content pixels with two populated panes, save `aria window-pane-resize-before` and `screenshot window-pane-resize-before`. Observe the separators and controlled regions. Run `focus`, then `resize --selector '[role="separator"][aria-label="Sidebar width"]' --by 20`, and repeat for `Sessions width` with `--by -40`. Use the exact observed label for the session-title separator and drag it by 80. Save before/after widths via `eval "[...document.querySelectorAll('[role=separator]')].map(e=>({name:e.getAttribute('aria-label'),value:e.getAttribute('aria-valuenow'),min:e.getAttribute('aria-valuemin'),max:e.getAttribute('aria-valuemax')}))"`, aria and PNG. Adjacent regions trade space while active title, transcript nodes, scroll and expanded messages remain. Repeat the last drag with `--cancel`; widths return to their starting values. Click that divider, then `key ArrowLeft`, `key Shift+ArrowRight`, `key Home`, `key End` and `key Enter`: 10/40 pixel steps, minimum/maximum and default ratio. `click --selector '<observed separator>' --double` also resets it. Drag to extreme bounds, then visit 1300/1299/1000/999/760 and restore 1440: no overflow or hidden separator tab stops, preferences recover where space permits. Close Right Pane and verify sidebar/list/detail resizing; in compact browsing only the sidebar/list divider remains. Repeat representative sizes in Light/Dark. Save `window-pane-resize-after` aria/PNG.
- **Dark appearance.** Force the dark theme. Run the same three commands with `'dark'` and the screenshot name `main-window-dark`. The media query is `true` and the screenshot shows light text on a dark background.
- **Restore.** Return to the system theme. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs main-eval "electron.nativeTheme.themeSource = 'system'"`. The result is `"system"`.

## Gotchas

- Screenshots cover the page only, not the title bar. The 720-point window height includes a 32-point title bar, so the page is 1100 × 688 points, and on a Retina display the PNG is 2200 × 1376 pixels.
- Do not assert the window's position. macOS places it, and it differs between runs.
- `setSize` stands in for dragging a corner, which this harness cannot do. It proves the minimum size and the layout at that size, not the drag itself.
- Never change the Mac's appearance setting. The `nativeTheme.themeSource` override is AgentPeek's own and ends when the app quits, but restore it before driving other features in the same run.
- Scrollbar width and overlay visibility follow Chromium/macOS behavior and the user's system preference. `thin` requests the platform's smaller variant rather than a fixed pixel width; a still screenshot may miss an auto-hidden thumb. Do not change the system scrollbar preference for verification. Computed styles alone do not prove thumb drawing, dragging or trackpad behavior.
- Expanded sidebar starts at 190 pixels; list preferences start at 420 single / 300 split. Minimum sidebar/list/detail sizes are 170/280/320 and sidebar maximum is 320. The 56-pixel rail has no divider. Capacity depends on reserved sidebar width; see navigation-visibility.md. Preferences survive toggles/resizes until quit/reload.
