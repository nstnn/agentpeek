# AgentPeek verification map

This folder is the maintained source for verifying what a user of AgentPeek can observe. Read this index before driving the app, then follow the matching feature file as the recipe. Command names below (`launch`, `doctor`, `click`, …) are subcommands of `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs`; the feature files spell each command out in full.

## Baseline preconditions

- The user approved launching AgentPeek for this task (see the skill's ground rules).
- `launch --label <feature>` succeeded, and `doctor` prints `doctor: OK`.
- The run uses an empty synthetic home unless the feature file names a fixture. The app reads that home only; `doctor` must confirm the snapshot and banner name it.
- No step drives an instance that this run did not start.

## Driving conventions

- Compatible recipes may share one health-checked run when their fixture, selection, size and theme preconditions hold. Reset those states through the documented controls between recipes. Launch a fresh run for an empty-home/bootstrap condition, after an unrecoverable failure, or after a lifecycle recipe ends the app. Never rebuild `out/` under a live helper run.
- Find handles with `aria` (page roles and names) and `menu` (menu labels). Use them literally, including case and spacing.
- Act through `click`, `key`, `type`, `menu-click`, `focus`, and `relaunch`. Observe through `aria`, `menu`, `eval`, `main-eval`, `screenshot`, and `wait-exit`.
- Menu items need the window focused: run `focus` before `menu-click` when `menu-click` reports `window not focused`.
- After a failed drive, run `doctor` before continuing. Restore a known UI state if the process is healthy but the page/menu is stuck. Expected CSP probe errors belong at the end of their run.
- Never change the Mac's settings to reach a state. Use the overrides a feature file names instead, and report them as overrides.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen: an `aria` or `menu` snapshot and a screenshot before and after the change, with the action in `actions.jsonl`.
- Record the feature file and sub-feature ID with every artifact name, for example `app-menu-reload.menu.txt`.
- When a step cannot run, report the command you tried and the unmet precondition. Never report a skipped entry point as verified through a different one.
- A step whose observed result differs from the recipe is a failure to report, not a recipe to rewrite. Change a recipe only when the product's intended behavior changed.
- `wait-exit` observes natural shutdown before cleanup; require `cleanExit: true`. `stop` then removes scratch data and any residue. Its `clean: true` alone does not prove the app exited cleanly on its own.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections, in this order:

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with agentpeek.mjs` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and its observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Navigation visibility](./navigation-visibility.md) covers independent Views rail/list toggles, retained reading state, available-width layout and source details.
- [Main window](./main-window.md) covers the window that opens at launch, its sidebar/list layout, its sizes, and its Light and Dark appearance.
- [Application menu](./app-menu.md) covers the menu bar's items, shortcuts, and disabled states.
- [Window and app lifecycle](./window-lifecycle.md) covers closing the window, quitting, and minimizing.
- [Single instance](./single-instance.md) covers opening AgentPeek while it is already open.
- [Renderer lockdown](./renderer-lockdown.md) covers what the page can and cannot do: no Node.js, no navigation, no new windows, no remote loads, no permissions.
- [Sessions connection](./sessions-connection.md) covers the live session total, fixture isolation, refresh, and clean service shutdown.
- [Sessions list](./sessions-list.md) covers views, filtering, groups, selection, keyboard/context entry points, tool health and list notices.
- [Session detail](./session-detail.md) covers messages, safe Markdown, long text, actions, focused read-on-view, two-pane placement/activation/isolation, compact split browse/return and pane selection, and single-pane narrow push/Back.
- [Fixture regression](./fixture-regression.md) covers the synthetic generator/simulator and built-app Playwright smoke, including combined two-pane selection, read isolation, compact navigation and reset on relaunch.
- [Local macOS package](./local-package.md) covers the signed arm64 bundle, fuses, native About panel, Finder reopen, window sizes and shutdown.
