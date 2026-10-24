# Skill content

Explicit skill links in Codex prompts appear as compact collapsed skill cards labeled Requested by you. Opening one shows safe read-only Markdown from the conversation when available, otherwise a clearly labeled current local file. This does not certify that the agent executed or applied a skill. Surrounding prompt text remains literal.

## Sub-features

- `skill-disclosure`: collapse/expand with pointer or Enter/Space, visible focus, retained live append state and reset on session replacement.
- `skill-provenance`: From this conversation versus Current local version, optional description and collapsed File details.
- `skill-recovery`: missing, blocked, unreadable, empty and limited content; Try Again and Reload Skill.
- `skill-safety`: inert HTML, image placeholders, no automatic network loads, bounded content and fixture-only reads.
- `skill-reading`: readable Light/Dark, minimum window and narrow detail, wrapping paths and reachable collapse while reading long content.

## How to get to it (user POV)

- Open a Codex session with an explicit skill link in the user prompt.
- Open the named skill card; its label names the requested skill.
- Expand File details to read the path, or use Try Again / Reload Skill when available.

## Driving it with agentpeek.mjs

Preconditions:

- User approval for this task's launches, current built app, a fresh generated synthetic fixture and passing doctor.
- After helper launch, read its run.json and run `npm run fixture -- simulate <copied-homeDir> skill-references`; paths must name that copied synthetic home. Open All Sessions and the observed Fixture Codex retry child row. Do not use the generator's original home for the simulator.
- Commands below abbreviate `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs`. Save before/after ARIA and PNG for each exercised transition. Derive selectors/labels from the actual ARIA and read-only DOM observations.

- **Collapsed (`skill-disclosure`).** Capture `aria skill-disclosure-collapsed` and `screenshot skill-disclosure-collapsed`. Six named cards are collapsed; Requested by you replaces the raw link and surrounding text remains. No body or full path is visible.
- **Recorded/current (`skill-provenance`).** Open the observed `synthetic-recorded` summary with `click --selector '.skill-card > summary' --nth 0`. Capture ARIA/PNG: From this conversation, its description and original recorded body appear despite a different local file. Open `synthetic-local` (nth 1): Current local version, historical-version caveat and local body. Expand its File details through the observed nested summary: only that path appears, with the skill card still open.
- **Keyboard/live (`skill-disclosure`).** On a focused skill summary use `key Space` to collapse and `key Enter` to reopen; capture the same focus outline. Append a synthetic reply only to this run's copied transcript and capture retained card expansion/content/focus. Switch to another session and back: cards reset collapsed. Hidden-pane deferred reads and discarded pending replacements also have component coverage.
- **Recover (`skill-recovery`).** Open the observed missing card (nth 2), capture its sanitized unavailable state, then run `npm run fixture -- simulate <copied-homeDir> skill-missing-restored` and click its observed Try Again. It now shows Current local version and the restored body. Run `skill-local-updated`, then click the local card's observed Reload Skill: its updated body appears without closing the card. Open the blocked card (nth 5): its path is refused, without rendering the forbidden body's text.
- **Long/empty (`skill-recovery`, `skill-reading`).** Open the long and empty cards (nth 3 and 4). Long content has a limit notice; empty content says This skill has no body text. Scroll into the long card with Recent messages and PageDown: its sticky summary remains reachable. Collapse it through that summary and confirm its start is visible. Capture ARIA/PNG at minimum window and a 320px detail pane; long paths/text wrap without page overflow.
- **Safety (`skill-safety`).** With the recorded card open, capture literal HTML and its image placeholder. Read-only `eval "({injected:globalThis.fixtureInjected===true,elements:document.querySelector('.skill-card').querySelectorAll('script,img,iframe,object,embed').length,network:performance.getEntriesByType('resource').filter(r=>/^https?:/.test(r.name)).length})"` returns false/zero/zero. Do not activate web links without separate browser-opening approval; component tests cover exact safe dispatch. Unit/source/IPC tests cover forged references, symlinks, credential paths, disabled-source epochs and output isolation.
- **Themes/cleanup (`skill-reading`).** Repeat representative recorded/current and narrow/keyboard captures using the app-only Light/Dark overrides in main-window.md; restore the recorded theme. Run doctor, close through Window > Close Window, require wait-exit cleanExit, then stop. Record default-profile metadata advisories without assigning a writer.

## Gotchas

- A plain `$name`, normal file link, inline/fenced code or quoted example does not become a skill card. Claude prompts keep their existing plain-text behavior.
- No recorded copy in the bounded tail does not prove there was never one. Current local version can differ from the file used historically. Missing recent references cannot authorize a local read.
- Local reads are limited to 128 KiB and display to 60,000 characters; paths use only approved skill roots. Fixture mode never uses workspace roots outside its copied home.
- No skill text is executed, persisted, logged or placed in snapshots. Reading a skill is not execution evidence.
- Native AX labels/Chromium keyboard actions do not prove VoiceOver or physical OS key delivery. Real-data and packaged acceptance need separate consent/evidence.
