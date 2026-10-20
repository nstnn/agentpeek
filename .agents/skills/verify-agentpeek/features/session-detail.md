# Session detail

Wide selection shows the session header and recent exchange. Narrow click/Return replaces the list with detail and Back. A loaded visible detail marks its current reply/error read when the native window is focused.

## Sub-features

- `detail-messages`: immediate header, last 20 messages, Latest exchange, times and tool summaries.
- `detail-loading`: loading, partial, empty, failed and Try Again states.
- `detail-markdown`: GFM, literal HTML, image alt text and safe web-link dispatch.
- `detail-title`: two-line initial title with the full accessible heading and width-aware Show Full Title / Show Less Title.
- `detail-long-message`: reversible 6,000-character preview and expansion up to 200,000, truthful cap notices, stable focus and reachable scroll controls.
- `detail-actions`: Open, Mark Read, Pin/Unpin and Copy Session ID.
- `detail-read`: loaded visible detail plus focus; viewing never clears waiting.
- `detail-navigation`: narrow click/Return, Back, Escape and Session > Back restore row/focus.
- `detail-live`: refresh preserves focus/scroll and discards stale requests.
- `detail-focus`: keyboard focus in Recent messages uses a short header-edge cue instead of a rectangle around the transcript; buttons and links retain their own focus indicators.
- `detail-source-recovery`: missing selections show Unavailable with frozen Last seen in AgentPeek and use bounded source reload instead of transcript retry.

## How to get to it (user POV)

- Select a row in any view; wide detail appears immediately.
- Narrow: arrows select; click or Return opens detail.
- Use header actions, Show Full Title / Show Less Title, Show More / Collapse Message, Back to Message Start, Try Again or Session/context menus.
- Return with Back, Escape or Session > Back (Command-[).

## Driving it with agentpeek.mjs

Preconditions:

- User approval for this task's launches; current built app, synthetic home, passing doctor.
- Synthetic running/waiting/error sessions, more than 20 messages, long and hostile Markdown.
- Commands abbreviate `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs`. Obtain literal names with `aria`. Save before/after aria and PNG for every transition.

- **Open.** `click --role option --name "<observed name>"`; `aria detail-open`; `screenshot detail-open`. Check header/path tooltip, actions, times, partial notice and tool summaries. Read-only `eval "document.querySelector('.latest-divider').getBoundingClientRect().top-document.querySelector('.transcript').getBoundingClientRect().top"` establishes initial alignment; older messages remain above it.
- **Focus appearance (`detail-focus`).** Open a synthetic session and click Recent messages; capture `aria detail-focus-pointer` and `screenshot detail-focus-pointer`: there is no rectangle around the transcript. Run `key Shift+Tab` to focus Copy Session ID without activating it; its compact outline is visible. Run `key Tab` back into Recent messages and capture `aria detail-focus-keyboard` plus `screenshot detail-focus-keyboard`: the focused region has a short accent line on the lower edge of its header. Run `key PageDown` on a long transcript: it scrolls while the cue stays visible. Shift-Tab returns to the preceding button, which has its own compact outline, and the region cue disappears. On a synthetic Markdown session, Tab to a link and check its focus indicator without activating it. Repeat in forced Light/Dark appearance and minimum-size narrow detail; wait for the layout to settle after resizing, then open the row. Back/Escape still returns to the selected list row with keyboard focus. Do not change the real clipboard or macOS settings.
- **Markdown.** Select the hostile row; capture. HTML is literal, images show alt text, tables/code work and unsafe schemes have no link. `eval "({elements:document.querySelector('.transcript').querySelectorAll('img,script,iframe,object,embed,video,audio,source,style,link').length,network:performance.getEntriesByType('resource').filter(r=>/^https?:/.test(r.name)).length})"` returns zeros. Browser opening requires separate authorization; contract tests verify exact URL dispatch.
- **Title (`detail-title`).** Select the synthetic long row at default/minimum size and content widths 999/1000. Save aria/PNG and read-only heading bounds/line-height: initial height is at most two lines while its accessible name contains the full title. `click --role button --name "Show Full Title"`, then `key Space` on Show Less Title: full text appears, then contracts, with the same button focused and accurate aria-expanded/aria-controls. Short titles have no disclosure. Repeat with unbroken/Unicode synthetic titles and after changing the selected title through the copied fixture; resize narrow/wide to check overflow controls recompute. The header scrolls independently so status/actions remain reachable.
- **Long text (`detail-long-message`).** Capture the 6,000-character notice and pre-expansion 200,000 cap/Open-tool guidance on the 211,200-character fixture. `click --role button --name "Show More"`; capture the 200,000-character notice, same focused toggle, stable controlled content and aria-expanded=true. Focus Recent messages with `click --role region --name "Recent messages"`, then `key PageDown` repeatedly; sticky Collapse Message and Back to Message Start remain visible. Click Back to Message Start and capture the local start with Collapse focused; scroll deep again, click Collapse Message, and capture the 6,000 preview at its useful local start, with the same focused toggle. Repeat expansion/collapse using Enter/Space, multiple long messages and a live synthetic update, then select another session and return: unrelated disclosure resets. Boundary lengths 5999/6000/6001/199999/200000/200001/211200 have component regressions. Code blocks scroll sideways without page overflow.
- **Read/live.** Select running detail; `blur`; capture; append a reply/completion only to the copied synthetic rollout. Capture unread attention, selected key and transcript scroll via read-only eval. `focus` clears unread without changing selection or scroll. `blur` is native window blur, not a physical app switch.
- **Error/waiting.** Select error and waiting rows; capture callouts. Acknowledged errors retain their detail and quoted Codex error/Claude terminal explanation. Viewing waiting leaves it waiting.
- **Retry.** Remove read permission from a copied synthetic rollout; select/capture failure. Restore permission; inspect the tree; `click --role button --name "Try Again"`; capture loaded messages and focus on Recent messages. Reconciliation may recover automatically. A known missing transcript uses Reload Sessions instead.
- **Source loss/recovery (`detail-source-recovery`).** Select a synthetic Codex session and capture `aria detail-source-recovery-before` plus `screenshot detail-source-recovery-before`; record Last seen in AgentPeek. Remove access only to the copied `.codex` directory and use View > Reload Sessions. Capture the unavailable row/detail: Unavailable — last known: <state>, the frozen observation time, disabled stale actions and Reload Sessions. Reload again while denied and after a newer Claude snapshot: time stays frozen, and completion alone never restores membership. Restore synthetic directory access, click `click --selector ".message-state button"`, then capture recovered messages and local focus. Repeat at default and 760 × 480 sizes (Enter opens narrow detail; Back/Escape restores the same row/list focus). A genuinely missing session stays unavailable with source-access/choose-another guidance. Rapid repeated Reload Sessions stays one pending request; changing selection never restores the previous selection. Rejected/hanging reloads and delayed results are also covered by transition tests; claim runtime evidence only for exercised cases.
- **Actions.** Click Pin; capture Unpin/count; then Unpin. Contract tests verify ID/tool/URL and stale targets. Actual clipboard and external activation need separate authorization/reporting.
- **Narrow.** `main-eval "BrowserWindow.getAllWindows()[0].setSize(760,480)"` stands in for resizing. Capture list/menu: Back disabled. Arrows then `key Enter` open detail with Back focused; capture menu: Back enabled. Test `key Escape`, `menu-click "Session > Back"`, and `click --role button --name "‹ <view name>"`: same selected row and listbox focus. Read-only `eval "document.documentElement.scrollWidth-innerWidth"` returns zero.
- **Cleanup.** Use main-window.md for app-only Light/Dark overrides, restore system, doctor, Window > Close Window, wait-exit, stop. Retain clean/defaultProfileUnchanged results.

## Gotchas

- Hidden narrow detail never loads or marks read; width alone never enables Back.
- Automatic read carries the loaded cursor; main rejects a newer reply.
- Terminal errors remain Error · Read in row and detail after acknowledgement until a newer turn starts; waiting semantics remain unchanged.
- Last seen in AgentPeek is snapshot membership observation, not proof of a fresh filesystem read. Missing membership freezes that time; unknown provenance remains Unknown.
- Conversation/error text is on-demand memory only, never snapshot/state data. Evidence is synthetic only.
- Loading/request races have component tests; fast real reads may finish before a screenshot.
- Title overflow and sticky-control geometry require a real renderer; mocked component dimensions cannot prove layout. Expanded text still obeys 200,000 characters and never loads full history.
- Test Collapse immediately after rapid PageDown, while keyboard scrolling is still moving: the preview must return to its message start after that motion settles. A subsequent wheel/key/pointer action must cancel that return instead of pulling the user's new scroll backward.
- DOM/AX labels do not establish VoiceOver speech, physical resizing, external activation or packaged behavior.
