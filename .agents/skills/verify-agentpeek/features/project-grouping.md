# Project grouping

The list defaults to Project, combining both tools when their working-folder paths match. Each project has an unfilled heading, a folder mark and a session-count badge, with its session rows indented below. A subtle background appears only on hover, and keyboard focus retains its visible outline. Collapsible headings keep attention and running counts visible, moving the summary below the name in narrow lists. Group by switches to Status without replacing either reading pane.

## Sub-features

- `project-no-folder` combines missing paths and Codex dated chat directories under No folder while retaining recorded paths in details.
- `project-identity` uses full paths, disambiguates repeated folder names and handles No folder.
- `project-hierarchy` distinguishes unfilled project headings from indented session rows in both themes and narrow/wide lists, including selected rows and long folder names.
- `project-density` keeps project groups and their session rows compact without changing text size, indentation, selection or keyboard focus.
- `project-motion` animates child height over 220ms, reverses smoothly on repeated toggles, and settles immediately under Reduce Motion while collapsed children are inaccessible and inert from the start.
- `project-collapse` retains current filtered summaries and collapse choices through live updates.
- `project-keyboard` navigates headers and expanded children with tree keys and visible focus.
- `project-retention` preserves both panes through collapse, grouping changes and source loss.

## How to get to it (user POV)

- Click Project or Status under Group by in any view. Project is the launch default.
- Click a project heading to expand/collapse it. Views and tool filters still apply.
- Tab through Group by and the tool filter into the tree. Up/Down/Home/End visit headings and expanded rows; Left/Right collapse/expand or move between parent and child; Enter/Space toggles a heading or activates a session.
- Open two sessions with Session > Open to the Right, then collapse their project. Focusing a reading pane reveals its row if it belongs to the current view/filter.

## Driving it with agentpeek.mjs

Preconditions:

- The user approved synthetic launches and focus/menu interaction for this task.
- Use a generator-owned synthetic home with both tools, shared paths, duplicate basenames, a long path and a session without a folder. Change only invented records before launch; never use real sessions.
- Run `launch --label project-grouping --fixture <absolute-synthetic-home>` and `doctor` using `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs`.
- Discover exact labels and selectors with `aria` and read-only `eval` before acting.
- Choose the view first. The app opens in Active, which lists running sessions only, so its headings show only running counts. Inbox shows only sessions that need attention. Waiting and idle synthetic chats, such as the No folder records below, appear only in All Sessions (or Pinned). Use View > All Sessions for steps that expect mixed attention/running summaries or non-running rows.

- **Identity.** Save `aria project-identity-initial` and `screenshot project-identity-initial`. Project is checked and the list is a tree. Both tools share the expected folder; duplicate names show full paths and No folder is separate. Inspect heading titles with `eval "Array.from(document.querySelectorAll('.project-heading')).map(e=>({text:e.textContent,title:e.title}))"`.
- **No folder.** Before launch, give two invented Codex chats distinct paths matching `/Users/synthetic/Documents/Codex/YYYY-MM-DD/<chat>` (including a trailing-slash case), a third no path, and another a normal project path. Save `aria project-no-folder-before` and `screenshot project-no-folder-before`: all three projectless chats share one No folder heading/count; the real project remains separate. Open an observed child via `click --role treeitem --name "<observed child name>"`; save `aria project-no-folder-open` and `screenshot project-no-folder-open`. Inspect `.detail-meta` with read-only `eval`: its title retains the original chat path. Collapse No folder through its observed `.project-heading` and capture ARIA/PNG: children disappear, count and reading pane stay. Switch to Status and back through the Group by radios: session membership and reading selection stay intact. Unit tests additionally cover Claude paths, descendant folders, tool filters and Pinned.
- **Hierarchy.** Save `aria project-hierarchy-expanded` and `screenshot project-hierarchy-expanded` before selecting a session, then click an observed child row and save `aria project-hierarchy-selected` and `screenshot project-hierarchy-selected`. Project headings have no persistent background and retain their folder marks; the selected session remains visually distinct and indented. Inspect a heading's background, its count badge and the first child row's bounds with read-only `eval`: unhovered headings are transparent. Hover shows a subtle fill; keyboard navigation retains the focus outline. At list widths below 300 pixels summaries occupy the next line; at 300 pixels and above they share the heading row. With a long name, the project label truncates while the count and summary stay inside the heading. Collapse a project: its count and summary remain visible. Switch to Status: its existing section and row alignment remain unchanged.
- **Collapse.** Use `click --selector ".project-heading" --nth 0`; save `aria project-collapse-closed` and `screenshot project-collapse-closed`. The heading is collapsed and its children leave the accessible tree; summaries remain. Apply a synthetic waiting/error/reply simulator step to the run's copied home. Save `aria project-collapse-updated` and `screenshot project-collapse-updated`: counts update without reopening or moving header focus. Change tool filters and views; collapse choices survive and counts describe current membership.
- **Density.** Capture `screenshot project-density` with expanded groups. Use read-only `eval` to inspect `.project-heading` and `.project-sessions .session-row`: each has 4-pixel vertical padding; a child row's `row-gap` between its own lines is 2 pixels and project group bottom margins are 6 pixels. At default 360-pixel and split 300-pixel list widths, running/attention summaries share the heading row. Text and status labels remain readable, selection/focus remain visible and child indentation stays 20 pixels. Repeat a narrow list and Light/Dark; there is no overlapping text or horizontal overflow. Status mode retains its existing spacing.
- **Motion.** With an expanded synthetic project, run `motion --selector '.project-heading' --name project-motion-close`, then the same command with `--name project-motion-open`. The saved `projects` samples show intermediate child heights, a zero collapsed height, restored natural height on expansion and no running animations after settling. Collapsed children are inert and aria-hidden immediately, including during the exit. From expanded state, add `--repeat-after 80` to reverse the collapse; intermediate PNGs/geometry show no snap to an endpoint. Run `--reduced-motion reduce` and `--reduce-after 80`: no intermediate motion under the initial preference, and changing it during motion settles immediately. Preference overrides are isolated to Chromium and cleared by the helper. Check narrow-list layout, keyboard collapse/re-expand and preserved reading panes as above. This does not prove physical display frame rate or delivery of the macOS Reduce Motion setting.
- **Keyboard.** With a heading clicked, use `key Home`, `key ArrowLeft`, `key ArrowDown`, `key ArrowRight`, `key ArrowRight`, `key ArrowLeft`, `key Space`, `key Enter`, and `key End`, observing each result. Closed children are skipped; Right expands, then enters the first child; Left from a child returns to its heading. Save `aria project-keyboard` and `screenshot project-keyboard`. Observe tree focus and its visible active descendant with `eval "({role:document.activeElement.getAttribute('role'),active:document.querySelector('[role=tree]').getAttribute('aria-activedescendant')})"`. VoiceOver speech is separate.
- **Panes and grouping.** Click a session and use `menu-click "Session > Open to the Right"`. Collapse its project: both titles/content remain. Focus a reading pane: its project expands and its row is selected. Use `click --role radio --name "Status"`, then Project: the selected session and both panes persist. Verify Project row drag/drop using session-detail.md.
- **Live retention.** Select a row and record its ID, top, list scroll and focused element via read-only `eval`. Complete it or add/remove an earlier project using synthetic records. Save `aria project-retention-live` and `screenshot project-retention-live`: the selected slot/top stays anchored, and summaries exclude rows retained outside current membership. Remove a selected synthetic source and reload: the retained row is Unavailable. Selecting another row releases it.
- **Sizes and themes.** Follow main-window.md for default/minimum sizing and forced Light/Dark. Capture `screenshot project-minimum-light` and `screenshot project-minimum-dark` with long names: disclosure, counts, grouping and filters remain usable with no horizontal overflow. Restore the app theme source recorded before the forced palette checks.
- **Cleanup.** Run `doctor`, `menu-click "Window > Close Window"`, `wait-exit --timeout 3000`, then `stop`. Report natural exit, cleanup, default-profile comparison, evidence and untested paths.

## Gotchas

- Project treeitems contain child rows. Click `.project-heading` to target the disclosure rather than the center of the whole treeitem.
- Codex dated chat directories are recognized by the macOS default path convention only. Custom chat roots stay separate; manually created folders matching the convention also join No folder.
- Full working-folder paths ignore trailing slashes. Worktrees, subfolders, aliases and symlink spellings remain separate; no Git detection occurs.
- Counts exclude retained rows outside current membership. A retained-only project can show zero.
- Collapsing a selected project clears its list cursor while preserving both panes. Header navigation alone does not load child transcripts or mark their replies read.
- Explicit pane placement/focus reveals only current-view/filter members. Snapshots never reopen a collapsed project.
- Grouping, collapse and header focus are renderer memory only and reset on reload/quit. Workspace paths are not added to saved state.
- Project uses tree/treeitem roles; Status keeps listbox/option roles. Use the observed roles.
