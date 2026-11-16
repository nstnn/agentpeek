# Window and app lifecycle

AgentPeek runs only while its window is open. Closing the window quits the app completely, with no background process left, and so does Quit. Minimizing sends the window to the Dock, and clicking it there brings it back.

## Sub-features

- `close-quits` closes the window and ends the run's main and helper processes without cleanup killing them.
- `quit-menu` ends AgentPeek from the first menu's Quit item.
- `minimize-restore` minimizes the window and restores it when the user brings AgentPeek forward.

## How to get to it (user POV)

- Click the window's red close button, choose Window > Close Window, or press Command-W.
- Choose AgentPeek > Quit AgentPeek, or press Command-Q.
- Choose Window > Minimize or press Command-M; click the window in the Dock to restore it.

## Driving it with agentpeek.mjs

Preconditions:

- A fresh run from `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs launch --label lifecycle`, and `doctor` prints `doctor: OK`. `close-quits` and `quit-menu` each end the app, so launch again before the next one.
- The window is focused: `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs focus` prints `"windowFocused": true`.

- **Close the window.** Choose Window > Close Window. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs menu-click "Window > Close Window"`, then at once `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs wait-exit --timeout 3000`. The click reports `"via": "performClose:"`; wait-exit reports `"exited": true`, `"cleanExit": true`, `"remainingProcesses": []` and `"portsStillOpen": []`. This is observed before any cleanup signal. The detached helper cannot recover the main app's exit code.
- **Cleanup.** Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs stop`. Require `"clean": true` and retained evidence. This removes scratch data and can kill residue, so it does not replace the natural-exit check above.
- **Quit.** Launch and focus again, then choose AgentPeek > Quit AgentPeek. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs menu-click "AgentPeek > Quit AgentPeek"`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs wait-exit --timeout 3000` and `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs stop`. The click reports `"via": "terminate:"`, wait-exit reports `"cleanExit": true` with no processes/ports left, and stop reports `"clean": true`.
- **Minimize.** Launch and focus again, then choose Window > Minimize. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs menu-click "Window > Minimize"`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs main-eval "BrowserWindow.getAllWindows()[0].isMinimized()"`. The click reports `"via": "performMiniaturize:"` and the check is `true`.
- **Restore.** Open AgentPeek again while it is minimized. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs relaunch`, then the same `isMinimized()` check. Relaunch reports `"secondExitCode": 0` and `"windowFocusedAfter": true`, and the check is `false`: the app itself restored the window (see single-instance.md). `focus` also un-minimizes, but the helper does that itself, so it proves nothing about the app.

## Gotchas

- The red close button and the Dock icon are outside this harness. `menu-click "Window > Close Window"` sends the same `performClose:` action that the button and Command-W send. A Dock click on the running app is handled by macOS, not by AgentPeek's code; the harness cannot reproduce it, so report it as unverified unless the user checks it or approves desktop control.
- Run `wait-exit` right after the action; it measures from its own start.
- After the app quits, `doctor` fails on `process alive` by design. Run `stop` anyway: it removes the scratch folder and confirms that no helper process or port is left.
- While the window is minimized, `doctor` fails `one visible window`, and `click` and `screenshot` may wait on a page that is not drawn. Restore before driving anything else.
