# Interface zoom

The View menu scales the entire interface from 80% to 150% in exact 10-point steps. Command-plus (also Command-equals) increases zoom, Command-minus decreases it, and Command-zero restores 100%. The menu shows the current percentage and a brief accessible notice confirms changes, including inside Settings. Zoom is remembered independently of Theme. Existing compact layouts adapt to the smaller available space while retaining selected sessions.

## Sub-features

- `zoom-steps`: exact steps, Actual Size, percentage feedback and disabled actions at each limit.
- `zoom-shortcuts`: Command-plus, Command-equals, Command-minus and Command-zero when the window is focused.
- `zoom-layout`: minimum/default sizes, two-pane selection and inactive reply isolation across layout changes.
- `zoom-settings`: zoom remains usable with visible feedback while Settings is modal.
- `zoom-persistence`: cold restart restores zoom and preserves Theme; older preferences default to 100%.
- `zoom-recovery`: a failed save restores the previous zoom and allows retry.

## How to get to it (user POV)

- Choose View → Zoom In, Zoom Out or Actual Size.
- Press Command-plus (or Command-equals), Command-minus or Command-zero while AgentPeek is focused, including with Settings open.
- Read the current percentage in View or the brief on-screen notice after a change.

## Driving it with agentpeek.mjs

Preconditions:

- User approval covers all synthetic launches for this verification task. Generate a synthetic home, launch with `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs launch --label zoom --fixture <synthetic-home>`, and require `doctor` to pass. Use only the helper-owned copied home for simulations.
- Observe handles with `aria zoom-initial` and `menu zoom-menu` before interacting. Take `screenshot zoom-initial`.

- **Steps (`zoom-steps`).** Run `focus`, then `menu-click "View > Zoom In"`. Immediately save `aria zoom-110` and `screenshot zoom-110`; require a `status` containing `Zoom 110%`. Observe `main-eval "BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()"`: 1.1. Zoom Out returns to 1.0; another gives 0.9; Actual Size returns to 1.0. Repeat Zoom In to 150%, save `menu zoom-upper-bound` and require Zoom In disabled; repeat Zoom Out to 80% and require Zoom Out disabled. Actual Size remains available at both ends. The status expires after 1.8 seconds; a later menu snapshot still shows the percentage.
- **Native shortcuts (`zoom-shortcuts`).** The helper's `key` goes only to the renderer and cannot prove menu accelerators. Use authorized native desktop input against this helper-owned process, verify its PID and focus first, then send Command-equals, Command-plus, Command-minus and Command-zero. After each native action observe the factor and capture the notice. If native input is unavailable, record physical shortcut dispatch as Not tested even if menu registration and click actions pass.
- **Reading and Settings (`zoom-layout`, `zoom-settings`).** Open two synthetic sessions using the list and Session → Open to the Right. At default size zoom from 100% to 120%: the list may disappear but both selected sessions remain. Reset and require the list to return. Capture before/after ARIA/PNG. Open Settings, choose a Theme, then zoom: the notice is inside the modal and Theme stays selected. Test the minimum 760 × 480 content size at 80% and 150%, Settings Close/Escape, reachable controls, no document overflow, divider dragging and retained reading offsets. An inactive pane's incoming synthetic reply must remain unread across zoom and compact transitions.
- **Cold restart and recovery (`zoom-persistence`, `zoom-recovery`).** With a matching built checkout and launch approval, run `npx playwright test e2e/zoom.spec.mjs`. This changes zoom through real menu handlers, checks exact factors, percentage feedback, bounds, responsive reading, Settings/read isolation, simulates a failed save only in its owned profile, retries, and cold-starts a second process to check zoom plus Theme. Keep PNG/ARIA and evidence.json. Unit tests separately cover legacy and malformed values and interleaved saves. The helper's concurrent `relaunch` alone does not prove persistence.
- **Cleanup.** Reset through View → Actual Size, close Settings, require `doctor`, choose the observed app menu's Quit, then require `wait-exit --timeout 3000` to report `cleanExit: true`. Run `stop` for scratch/process/port cleanup and remove the generator-owned original fixture separately.

## Gotchas

- Window → Zoom changes the window size; use View commands to scale its content.
- Browser zoom reduces CSS layout space. A compact transition is expected when columns no longer fit; it must not change selected sessions or acknowledge inactive replies.
- Do not call setZoomFactor through eval/main-eval to drive this feature. Read the factor after menu or native keyboard actions.
- A failed save rolls back the scale and menu percentage; the failure notice lasts six seconds. Retry the same action after resolving the save problem.
- Synthetic unpackaged evidence does not prove packaged behavior, real-data compatibility or VoiceOver speech.
