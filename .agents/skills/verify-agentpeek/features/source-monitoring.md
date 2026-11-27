# Source monitoring

Connected tools appear above Settings as a dot and name, or a one-letter mark in the collapsed rail (C for Codex, A for Claude Code, G for Antigravity). These are non-interactive status indicators, skipped by Tab. A thin divider separates the tools from Settings in both layouts. While Remote View is on, its "Remote View on" button sits between the tools and Settings. Settings contains independent Monitor Codex, Monitor Claude Code and Monitor Antigravity switches with actual source health, plus Antigravity's transcript-only and status-scope note. OFF stops monitoring and hides sessions/counts while retaining pins/read markers; an open selection shows Monitoring off. Choices survive restarting AgentPeek.

## Sub-features

- `sources-footer`: only connected tools, bottom placement, non-interactive names/rail letters C, A and G, and a divider above Settings.
- `sources-switches`: independent accessible switches (three, Antigravity included), default ON, actual health separate from ON/OFF. A preferences file saved before Antigravity existed keeps its Codex and Claude Code choices and starts Antigravity ON.
- `sources-off`: disabled-source lists/counts and reading placeholder; both-off Settings recovery.
- `sources-persistence`: saved choice restored before monitoring starts, pins/read markers retained.
- `sources-recovery`: failed save leaves monitoring unchanged, retry and re-enabling rediscovery.
- `sources-antigravity-recovery`: replacing an unsupported transcript with a supported one recovers source health and session activity while monitoring stays on.
- `sources-layout`: Light/Dark, minimum/default sizes, modal keyboard and switch focus retention.

## How to get to it (user POV)

- Click Settings in the sidebar/rail or choose AgentPeek → Settings… (Command-comma).
- Connected tools above Settings show connection status only; clicking them does nothing.
- In Sources, click Monitor Codex, Monitor Claude Code or Monitor Antigravity. Tab reaches each switch; Space or Enter changes it.
- From a disabled source's reading placeholder or empty list, click Open Settings.
- Close with Close Settings or Escape. Focus returns to the Settings trigger.

## Driving it with agentpeek.mjs

Preconditions:

- User approval covers all synthetic launches and cold restarts for this task. Use a populated generator fixture, launch with `launch --label source-monitoring --fixture <synthetic-home>` and require `doctor` to pass.

- **Footer (`sources-footer`).** Save `aria sources-footer` and `screenshot sources-footer`. Codex and Claude Code appear directly above Settings (with Remote View off) as images with Connected accessible names, and no switch exists outside Settings. Run `click --role image --name "Codex source: Connected"` and `click --role image --name "Claude Code source: Connected"`: neither opens Settings or changes session navigation. Capture the unchanged state. Confirm a thin horizontal divider sits between the tools and Settings. Run `click --role button --name "Collapse Views"`, capture the rail and repeat both clicks: the indicators remain non-interactive. Tab from the selected view skips both indicators and reaches Settings; Return opens the dialog. Capture ARIA/PNG before and after each layout's clicks and the Settings entry.
- **Switches and off state (`sources-switches`, `sources-off`).** Capture `aria sources-settings` and `screenshot sources-settings`. Use `click --role switch --name "Monitor Codex"`; after Saving settles its checked state is false. Escape returns to a list without Codex sessions/counts and no Codex footer entry. When a Codex reading selection was open, its pane shows Codex monitoring is off with Open Settings, rather than stale messages. Open Settings, turn Claude Code and Antigravity off too, then Escape: the empty list explains Monitoring is off and offers Open Settings. A fixture home without `~/.gemini/antigravity` shows Antigravity as Not installed while ON. Turn sources on again and observe Checking… followed by actual health; ON alone must not mean Connected.
- **Persistence, failure and keyboard (`sources-persistence`, `sources-recovery`, `sources-layout`).** With the approved matching build, run `npm run e2e -- e2e/source-monitoring.spec.mjs e2e/settings.spec.mjs --output <new-evidence-dir>`. The separately owned Playwright runs use synthetic profiles, exercise source choices, pin recovery across a cold start, temporary save failure/retry, switch Space/focus, dialog keyboard containment and Light/Dark at minimum/default sizes. They save PNG/ARIA, evidence.json and cleanup results. Component/service tests additionally cover late catalog/message results, disabled-source access gates, and read-marker retention; distinguish these from live proof.
- **Antigravity live recovery (`sources-antigravity-recovery`).** Start with one unsupported synthetic Antigravity transcript in the run's home and keep Settings open. Capture `aria sources-antigravity-unsupported` and `screenshot sources-antigravity-unsupported` with Monitor Antigravity on and health Unsupported format. In the run's synthetic home, atomically replace the transcript with a recent supported user step. Without reloading or changing focus, capture `aria sources-antigravity-connected` and `screenshot sources-antigravity-connected` once health is Connected. Close Settings and open All Sessions. Capture the rediscovered row as Running in fixture mode. Source and service tests cover failed process lookups and retries while the turn is fresh because fixture mode substitutes a successful lookup. When the app's liveness cannot be confirmed, the desktop row shows Unknown and the detail explains that AgentPeek could not confirm Antigravity is running.
- **Antigravity footer and Settings note (`sources-footer`, `sources-switches`).** Launch the seeded Antigravity fixture from the [baseline preconditions](./README.md) with `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs launch --label source-monitoring-antigravity --fixture <home>` and require `doctor`. Capture `aria sources-footer-antigravity` and `screenshot sources-footer-antigravity`: a third indicator named `Antigravity source: Connected` sits below Codex and Claude Code. `click --role image --name "Antigravity source: Connected"` changes nothing. Run `click --role button --name "Collapse Views"` and capture `screenshot sources-footer-antigravity-rail`: the rail letters read C, A and G. Open Settings and capture `aria sources-settings-antigravity`: Monitor Antigravity is on with Connected health, and beside it the note says Desktop conversations with transcripts only, excludes older legacy sessions, and shows Running, Idle, Unknown and new replies. Turn Monitor Antigravity off and press Escape: the three Antigravity rows, the footer indicator and the G letter disappear, and Active drops to 7. Turn it on again before cleanup.
- **Cleanup.** Run `doctor`, `focus`, inspect `menu`, and choose the observed Quit command. Require `wait-exit --timeout 3000` to report `cleanExit: true`, then `stop`. Remove the generator's original synthetic fixture separately; keep evidence folders.

## Gotchas

- ON permits AgentPeek to monitor local files; it does not launch, quit, sign in to, or change any tool.
- Connected for Antigravity confirms access to transcript-backed Desktop conversations only (not older `.pb`-only legacy history), and Open Antigravity only brings the app to the front, never one conversation.
- A source may remain ON while Not installed, No access or Unsupported format. Only Connected tools appear in the footer; all sources remain reachable in Settings.
- Saving temporarily prevents further source changes without removing switch keyboard focus. Failed saves leave the previous choice in place.
- Already queued reads may complete after OFF; their results must not repopulate sessions or return messages.
- Dialog content scrolls at minimum window height; the Close header remains available. UI/API observations do not prove VoiceOver speech or physical native accelerator delivery.
