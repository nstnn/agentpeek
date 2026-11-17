# Find Session and durable pins

## Sub-features

- `inbox-waiting`: Inbox includes Waiting before unread errors/replies, counts each session once and retains Waiting after viewing.
- `find-session`: the header button and View → Find Session… (⌘K) search loaded titles, folder paths and IDs across views/tools.
- `find-keyboard`: arrows/Home/End choose a result, Enter opens in the active/remembered pane, Escape cancels; native Edit supports paste/undo.
- `find-isolation`: the modal preserves panes/filters, pauses covered reads/acknowledgements, handles empty matches and live source changes.
- `pins-durable`: saved pins survive age/count limits, 90-day cleanup and restart. Missing files show Unavailable and can be unpinned; restored files recover through Reload Sessions.

## How to get to it (user POV)

- Select Inbox to find Waiting sessions. Group by Status to see their separate section.
- Click Find Session beside the view title or choose View → Find Session… (⌘K), type title/folder/ID, use arrows and Enter or click a result. Escape/Close cancels.
- Select a session and choose Pin, then open Pinned. Old pins remain available while source monitoring is on. Unavailable pins retain their ID and allow Unpin.

## Driving it with agentpeek.mjs

Preconditions:

- Launch/focus/relaunch permission for this task; a generated synthetic fixture; a built app and a passing doctor.
- Use only this helper's copied home. Never alter real tool data. Native menu steps require focus.

- **Waiting:** `menu-click "View > Inbox"`, `click --role radio --name "Status"`, `aria inbox-waiting`, `screenshot inbox-waiting`. Observe Waiting for you ahead of unread result sections. Click the observed waiting row, capture again: the badge and Waiting persist. Simulate `claude-new-turn` in the copied home; Reload Sessions then removes it from Inbox and restores it to Active.
- **Find:** `menu-click "View > Find Session…"`, `aria find-initial`, `screenshot find-initial`; `type "Fixture Codex"`, `key ArrowDown`, `aria find-selected`, `screenshot find-selected`, `key Enter`. Observe the chosen detail. Repeat with full folder path and session ID. View/tool filters remain unchanged. Use a nonexistent query to see No matching sessions; Escape restores the original reading panes.
- **Isolation:** while Find Session is open, simulate a fresh reply to the covered session and Reload after dismissing; capture metadata/read counts before and after. No acknowledgement occurs while the dialog covers it. Exercise Tab/Shift-Tab containment, Escape and native View shortcut; Settings and navigation do not replace covered panes.
- **Pins:** pin a row via Session > Pin; capture `aria pin-before`, `screenshot pin-before`. Quit through the native menu and `wait-exit`; retain the same isolated home/profile for a fresh instance. For age testing, age only synthetic source timestamps/record times while stopped; reload alone does not age records. Capture the old pin after startup. Temporarily remove its synthetic source file, Reload Sessions and capture the Unavailable row/detail with Unpin enabled. Restore the file and Reload to recover. Unpin the unavailable row and observe the Pinned count drop. Test Codex and Claude, missing-file restart and source off/on.
- **Built regression:** after launch approval, `npx playwright test e2e/attention-search-pins.spec.mjs --output test-results/attention-search-pins-<unique-id>` owns its profiles/processes separately from the helper, captures action states and tests cold restarts/age limits. Never attach the helper to it.

## Gotchas

- Search covers loaded metadata only, not full transcript history. It shows at most 50 results and requests refinement above that cap.
- Source monitoring off deliberately hides its pins and prevents reads; re-enabling restores them.
- No title/path/conversation copy is persisted for a pin. An unavailable pin after restart is identified by ID.
- Fixture liveness cannot prove actual tool process health. Synthetic timestamp changes do not prove physical sleep/wake.
- Always retain before/after ARIA and screenshots, then quit and run cleanup. Never rebuild out/ under a live helper run.
