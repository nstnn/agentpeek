# Session history

All Sessions lists sessions active in the last 7 days, at most 50 per tool, plus saved pins and open Claude Code sessions. Settings > Session history changes that saved range: 7, 30 or 90 days or 1 year, and 50, 100, 200 or 500 sessions per tool. While a source left out older sessions, All Sessions offers Load Older Sessions below the list; each use doubles the loaded days and per-tool cap until quit or the next saved change. Replies that finished more than 90 days ago count as read, so loaded older sessions never flood attention counts.

## Sub-features

- `history-footnote`: All Sessions names the loaded days and per-tool cap, and says when older sessions stay loaded until quit.
- `history-load-older`: Load Older Sessions appears only while a source left out older sessions; it shows Loading… and ignores repeated clicks while pending, then doubles the loaded range; a failure shows an inline error and the button stays available.
- `history-settings`: Settings > Session history shows the saved range in two AgentPeek-styled pop-up menus (combo boxes whose list opens above the dialog, marks the saved value with a check and is driven by mouse or keyboard: Up/Down/Enter/Space open, arrows/Home/End move, Enter/Space choose, Escape closes only the list, a typed character while closed picks the next match); each change saves, lists again and resets any Load Older extension; a failed save shows an inline error and keeps the saved range.
- `history-persistence`: the saved range is restored on a cold start; Load Older extensions are not.
- `history-old-replies`: replies older than 90 days count as read in every view and count.

## How to get to it (user POV)

- Choose View > All Sessions (Command-4) and read the line below the list. Click Load Older Sessions when it is shown.
- Open Settings and choose values under Session history.

## Driving it with agentpeek.mjs

Preconditions:

- User approval covers synthetic launches for this task. Create a fixture with `npm run fixture -- create`, then `launch --label session-history --fixture <synthetic-home>` and require `doctor` to pass. The standard fixture includes rollouts and transcripts older than 7 days.

Steps:

- **Footnote and button (`history-footnote`, `history-load-older`).** Run `menu-click "View > All Sessions"`. Capture `aria history-initial` and `screenshot history-initial`: the footnote says 7 days and 50 per tool and the observed All Sessions count. If the fixture holds older sessions, Load Older Sessions is present. Run `click --role button --name "Load Older Sessions"`, then capture `aria history-loaded` and `screenshot history-loaded`: the footnote says 14 days and 100 per tool and that older sessions stay loaded until quit, and the All Sessions count is at least the earlier one. Repeat until the button disappears or the count stops growing.
- **Settings (`history-settings`).** Open Settings with `click --role button --name "Settings"`. Capture `aria history-settings`: two named combo boxes, Show sessions active in the last and At most, per tool, whose text is the saved value. Mouse: `click --role combobox --name "Show sessions active in the last"`, capture `screenshot history-settings-open` (the list sits right-aligned under the box, above the dialog, unclipped, with a check on the saved value), then `click --role option --name "30 days"`. Keyboard: focus `At most, per tool` with `key Tab`, then `key ArrowDown` opens the list, `key Escape` closes only the list (Settings stays open), and `key Enter`, `key End`, `key Enter` chooses 500 sessions. Check both themes. Observe `eval "window.agentpeek.getSnapshot().then(s => s.range)"`: saved and loaded values match the choice and any earlier Load Older extension is gone.
- **Persistence (`history-persistence`).** `src/main/preferences.test.ts` covers saving, restoring and ignoring an invalid saved range. For a runtime check, choose a range, quit through the App menu and require `wait-exit` to report `cleanExit: true`; the helper starts every run with a fresh profile, so a cold start on the same profile is not observable through it and is reported as not tested.
- **Old replies (`history-old-replies`).** Covered by `src/main/sessions/service.test.ts`; a runtime check needs a synthetic reply older than 90 days after the tool's baseline.

## Gotchas

- Load Older reads more files; on large synthetic homes it can take seconds. The button stays in Loading… until the main process finishes listing.
- Older Codex rollouts can be child threads, which are never listed. The button can therefore load nothing new; it disappears once the loaded range covers every rollout or after ten doublings.
- Older Claude Code sessions are listed only when Claude.app's catalog names them or they are pinned or open. CLI sessions that finished and have no catalog entry stay out at any range.
