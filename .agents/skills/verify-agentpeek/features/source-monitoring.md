# Source monitoring

Connected tools appear directly above Settings as a dot and name, or initials in the collapsed rail. Settings contains independent Monitor Codex and Monitor Claude Code switches with actual source health. OFF stops monitoring and hides sessions/counts while retaining pins/read markers; an open selection shows Monitoring off. Choices survive restarting AgentPeek.

## Sub-features

- `sources-footer`: only connected tools, bottom placement, simple names/rail initials and Settings entry.
- `sources-switches`: independent accessible switches, default ON, actual health separate from ON/OFF.
- `sources-off`: disabled-source lists/counts and reading placeholder; both-off Settings recovery.
- `sources-persistence`: saved choice restored before monitoring starts, pins/read markers retained.
- `sources-recovery`: failed save leaves monitoring unchanged, retry and re-enabling rediscovery.
- `sources-layout`: Light/Dark, minimum/default sizes, modal keyboard and switch focus retention.

## How to get to it (user POV)

- Click Settings in the sidebar/rail or choose AgentPeek → Settings… (Command-comma).
- Click a connected tool above Settings to open the same dialog.
- In Sources, click Monitor Codex or Monitor Claude Code. Tab reaches each switch; Space or Enter changes it.
- From a disabled source's reading placeholder or empty list, click Open Settings.
- Close with Close Settings or Escape. A connected-source trigger regains focus; if it disappeared, focus returns to Settings.

## Driving it with agentpeek.mjs

Preconditions:

- User approval covers all synthetic launches and cold restarts for this task. Use a populated generator fixture, launch with `launch --label source-monitoring --fixture <synthetic-home>` and require `doctor` to pass.

- **Footer (`sources-footer`).** Save `aria sources-footer` and `screenshot sources-footer`. Codex and Claude Code appear directly above Settings, each with a Connected accessible name, and no switch exists outside Settings. Run `click --role button --name "Collapse Views"`, capture the rail, then `click --role button --name "Codex source: Connected"`: Settings opens.
- **Switches and off state (`sources-switches`, `sources-off`).** Capture `aria sources-settings` and `screenshot sources-settings`. Use `click --role switch --name "Monitor Codex"`; after Saving settles its checked state is false. Escape returns to a list without Codex sessions/counts and no Codex footer entry. When a Codex reading selection was open, its pane shows Codex monitoring is off with Open Settings, rather than stale messages. Open Settings, turn Claude Code off too, then Escape: the empty list explains Monitoring is off and offers Open Settings. Turn sources on again and observe Checking… followed by actual health; ON alone must not mean Connected.
- **Persistence, failure and keyboard (`sources-persistence`, `sources-recovery`, `sources-layout`).** With the approved matching build, run `npm run e2e -- e2e/source-monitoring.spec.mjs e2e/settings.spec.mjs --output <new-evidence-dir>`. The separately owned Playwright runs use synthetic profiles, exercise source choices, pin recovery across a cold start, temporary save failure/retry, switch Space/focus, dialog keyboard containment and Light/Dark at minimum/default sizes. They save PNG/ARIA, evidence.json and cleanup results. Component/service tests additionally cover late catalog/message results, disabled-source access gates, and read-marker retention; distinguish these from live proof.
- **Cleanup.** Run `doctor`, `focus`, inspect `menu`, and choose the observed Quit command. Require `wait-exit --timeout 3000` to report `cleanExit: true`, then `stop`. Remove the generator's original synthetic fixture separately; keep evidence folders.

## Gotchas

- ON permits AgentPeek to monitor local files; it does not launch, quit, sign in to, or change either tool.
- A source may remain ON while Not installed, No access or Unsupported format. Only Connected tools appear in the footer; all sources remain reachable in Settings.
- Saving temporarily prevents further source changes without removing switch keyboard focus. Failed saves leave the previous choice in place.
- Already queued reads may complete after OFF; their results must not repopulate sessions or return messages.
- Dialog content scrolls at minimum window height; the Close header remains available. UI/API observations do not prove VoiceOver speech or physical native accelerator delivery.
