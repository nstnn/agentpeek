# Single instance

Only one AgentPeek runs at a time. Opening AgentPeek while it is already open does not start a second copy: the new copy exits at once, and the existing window comes to the front, restored if it was minimized.

## Sub-features

- `second-launch-exits` makes a second copy exit with code 0, leaving the first one running with its one window.
- `second-launch-focuses` brings the existing window to the front and restores it from the Dock if needed.

## How to get to it (user POV)

- Open AgentPeek again while it is open: from Finder, Spotlight, or the Dock in a packaged build, or by running `npm start` again in development.

## Driving it with agentpeek.mjs

Preconditions:

- The user approved that this step pulls focus to AgentPeek.
- A fresh run from `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs launch --label single-instance`, and `doctor` prints `doctor: OK`.

- **Second launch.** Open AgentPeek again. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs relaunch`. The result has `"secondExitCode": 0`, `"timedOut": false`, `"firstStillAlive": true`, `"windows": 1`, and `"windowFocusedAfter": true`. Record the observed `elapsedMs`; it is machine-dependent, not a fixed one-second requirement.
- **Second launch while minimized.** Minimize the window, then open AgentPeek again. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs focus`, `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs menu-click "Window > Minimize"`, and `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs relaunch`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs main-eval "BrowserWindow.getAllWindows()[0].isMinimized()"`. Relaunch reports `"windowFocusedBefore": false` and `"windowFocusedAfter": true`, and the check is `false`.
- **Proof.** Capture the restored window. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs screenshot single-instance-restored` and `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs doctor`. The screenshot shows the session interface and doctor still prints `doctor: OK`.

## Gotchas

- The lock belongs to the profile folder. A copy with another profile, such as the user's own AgentPeek or a second verification run, is a separate instance by design; that is what lets runs sit side by side. `relaunch` reuses the run's profile, so it does test the lock.
- If the window was already focused, `"windowFocusedAfter": true` proves nothing about focus. The minimized step starts from an unfocused window and is the real focus proof.
- `relaunch` pulls focus away from the user's app twice in the minimized step (`focus`, then the second launch).
