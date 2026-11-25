# Fixture regression

The synthetic simulator changes the same local file shapes the tools write. The built app shows those changes live, while its fixture banner identifies the isolated home. A separate Playwright smoke checks bootstrap, one timed update, combined two-pane navigation/read isolation, pin persistence and renderer-file-only requests. The full E2E suite also includes Find Session and pins, Codex handoff, Settings, Source monitoring, Zoom and Remote View scenarios.

## Sub-features

- `fixture-bootstrap`: pre-existing running sessions, historical reply baseline and per-tool caps.
- `fixture-transitions`: completed, failed, stopped and permission-denied turns; attention clears on a newer turn.
- `fixture-stress`: long messages/titles, hostile Markdown, malformed lines and source/read failures.
- `fixture-reconcile`: old resumed thread and removed registry.
- `fixture-antigravity`: `antigravity-seed` adds Antigravity idle (shortened reply), running and quiet conversations to a fresh home before launch; the Antigravity recipes in sessions-list.md, session-detail.md, app-menu.md and source-monitoring.md drive them.
- `fixture-smoke`: built-app automation, retained evidence, profile isolation and cleanup.
- `fixture-split-smoke`: A/B to C/B selection, inactive/hidden replies, active read, compact Back/Hide Sessions, close-to-single and layout reset on relaunch.

## How to get to it (user POV)

- Create data with `npm run fixture -- create`; launch AgentPeek with the two printed overrides after approval.
- Change synthetic tool activity with `npm run fixture -- simulate <home> <step>`.
- Read Active, All Sessions and Pinned, open detail, choose Show More / Collapse Message or Try Again, or use View > Reload Sessions.
- After a build and launch approval, run `npm run e2e -- e2e/smoke.spec.mjs --output <new-evidence-dir>` for the smoke alone. `npm run e2e -- --output <new-evidence-dir>` runs all nine specs in `e2e/`: smoke, `attention-search-pins` (see find-session-pins.md), `codex-open` (see session-detail.md), Settings, Source monitoring, Zoom and the three Remote View specs (`remote-settings`, `remote-messages-switch`, `remote-desktop-status`), each with its own launches. Prefix `AGENTPEEK_E2E_BACKGROUND=1` while the user is using the Mac: the window stays invisible and unfocused and native focus is emulated, so treat that run as a regression check, not as focus or acceptance evidence. `npm run e2e -- --list` lists them without launching anything.

## Driving it with agentpeek.mjs

Preconditions:

- User approval covers this task's launches and fixture-only control. Read `scripts/fixture/README.md` for steps.
- `npm run fixture -- create` printed the original synthetic home. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs launch --label fixture-regression --fixture <original-home>`.
- Record the copied `homeDir` from `run.json`; all following simulator commands target that copied home. `doctor` passes.
- Every Playwright invocation needs its own new output directory, for example `test-results/<unique-run>/smoke`. Replace `<new-evidence-dir>` with a fresh path; Playwright clears that directory before running, so reusing it can erase retained evidence.

- **Bootstrap.** Save `aria fixture-bootstrap` and `screenshot fixture-bootstrap`. The banner names the copied home; Active has seven running rows, no historical new replies. Click the observed All Sessions button with `click --role button --name "<observed name>"`; save both artifacts. Each tool lists 50.
- **Live.** Return to Active and keep Codex complete unselected. Save before artifacts, run `npm run fixture -- simulate <copied-home> codex-complete` once, then save `aria fixture-complete` and `screenshot fixture-complete`. The row leaves Active; choose View > Inbox and confirm New reply there. Reading clears its Inbox count; All Sessions retains it. Playwright measures the write-to-row interval; sequential helper snapshots alone are not a latency measurement.
- **Other transitions.** Apply steps from the fixture guide one at a time, save before/after artifacts, and check its expected row state. Use All Sessions to find Idle rows. Select a different row to prevent automatic read-on-view from clearing attention being inspected.
- **Antigravity seed (`fixture-antigravity`).** Run `npm run fixture -- create`, then `npm run fixture -- simulate <home> antigravity-seed` on the printed original home; a second run of the step fails without writing. Launch with `--fixture <home>` and require `doctor`. All Sessions lists Fixture Antigravity idle (Idle), running (Running) and quiet (Unknown · Quiet for 15 min), Active shows 8, and Inbox is unchanged because the seeded reply is a historical baseline. Capture `aria fixture-antigravity` and `screenshot fixture-antigravity`.
- **Reconcile.** Run `npm run fixture -- simulate <copied-home> old-resumed`; choose `menu-click "View > Reload Sessions"`. Capture the old row appearing as Running. Apply `registry-removed`; the catalog-backed dead row becomes Idle. This does not prove real PID death.
- **Detail stress.** Follow session-detail.md with the Codex long, hostile and retry rows. The simulator supplies `read-failure`/`read-restored`. No external links or Open-tool buttons are clicked without separate authorization.
- **Smoke.** Run `npm run e2e -- e2e/smoke.spec.mjs --output <new-evidence-dir>` for one separately owned smoke with two launches. Do not attach this helper to it. Inspect its `evidence.json`, PNG and ARIA files beneath the chosen output directory; requests include bootstrap and all observed URLs must be renderer files. The `split-a-b`, `split-c-b`, `split-inactive-reply` and `split-active-read` captures show row drag opening, left/right replacement, Escape cancellation and active-pane selection; Left changes while Right retains its key and unread reply until activation. `split-compact-back`, `split-compact-main` and `split-closed-single` show hidden details, Hide Sessions/selector and restored single-pane focus. The second launch has no selected session or Right pane and keeps the pin. Cleanup reports no profile processes and fixture removed. The other specs have their own recipes and evidence in their feature files; the untargeted full-suite command runs all nine.
- **Cleanup.** Run helper `doctor`, then `stop`; require `clean: true`. Remove the generator-owned original with `npm run fixture -- clean <original-home>`. Keep both evidence folders.

## Gotchas

- Fixture mode always treats processes as alive; Unknown due to a dead PID is service-test evidence only.
- A malformed JSON line is ignored; it need not make a row Unknown. Unsupported file shapes are a different case.
- Never simulate against a real home, start a scenario loop, or replay a failed smoke without a material fix and task launch approval.
- Manual checks, real sleep/wake, VoiceOver, external app activation, packaged behavior and real data remain untested until observed through those paths.
