# Project grouping

The list defaults to Project, combining both tools when their working-folder paths match. Collapsible headings keep session, attention and running counts visible. Group by switches to Status without replacing either reading pane.

## Sub-features

- `project-identity` uses full paths, disambiguates repeated folder names and handles No folder.
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

- **Identity.** Save `aria project-identity-initial` and `screenshot project-identity-initial`. Project is checked and the list is a tree. Both tools share the expected folder; duplicate names show full paths and No folder is separate. Inspect heading titles with `eval "Array.from(document.querySelectorAll('.project-heading')).map(e=>({text:e.textContent,title:e.title}))"`.
- **Collapse.** Use `click --selector ".project-heading" --nth 0`; save `aria project-collapse-closed` and `screenshot project-collapse-closed`. The heading is collapsed and its children leave the accessible tree; summaries remain. Apply a synthetic waiting/error/reply simulator step to the run's copied home. Save `aria project-collapse-updated` and `screenshot project-collapse-updated`: counts update without reopening or moving header focus. Change tool filters and views; collapse choices survive and counts describe current membership.
- **Keyboard.** With a heading clicked, use `key Home`, `key ArrowLeft`, `key ArrowDown`, `key ArrowRight`, `key ArrowRight`, `key ArrowLeft`, `key Space`, `key Enter`, and `key End`, observing each result. Closed children are skipped; Right expands, then enters the first child; Left from a child returns to its heading. Save `aria project-keyboard` and `screenshot project-keyboard`. Observe tree focus and its visible active descendant with `eval "({role:document.activeElement.getAttribute('role'),active:document.querySelector('[role=tree]').getAttribute('aria-activedescendant')})"`. VoiceOver speech is separate.
- **Panes and grouping.** Click a session and use `menu-click "Session > Open to the Right"`. Collapse its project: both titles/content remain. Focus a reading pane: its project expands and its row is selected. Use `click --role radio --name "Status"`, then Project: the selected session and both panes persist. Verify Project row drag/drop using session-detail.md.
- **Live retention.** Select a row and record its ID, top, list scroll and focused element via read-only `eval`. Complete it or add/remove an earlier project using synthetic records. Save `aria project-retention-live` and `screenshot project-retention-live`: the selected slot/top stays anchored, and summaries exclude rows retained outside current membership. Remove a selected synthetic source and reload: the retained row is Unavailable. Selecting another row releases it.
- **Sizes and themes.** Follow main-window.md for default/minimum sizing and forced Light/Dark. Capture `screenshot project-minimum-light` and `screenshot project-minimum-dark` with long names: disclosure, counts, grouping and filters remain usable with no horizontal overflow. Restore the system theme override.
- **Cleanup.** Run `doctor`, `menu-click "Window > Close Window"`, `wait-exit --timeout 3000`, then `stop`. Report natural exit, cleanup, default-profile comparison, evidence and untested paths.

## Gotchas

- Project treeitems contain child rows. Click `.project-heading` to target the disclosure rather than the center of the whole treeitem.
- Full working-folder paths ignore trailing slashes. Worktrees, subfolders, aliases and symlink spellings remain separate; no Git detection occurs.
- Counts exclude retained rows outside current membership. A retained-only project can show zero.
- Collapsing a selected project clears its list cursor while preserving both panes. Header navigation alone does not load child transcripts or mark their replies read.
- Explicit pane placement/focus reveals only current-view/filter members. Snapshots never reopen a collapsed project.
- Grouping, collapse and header focus are renderer memory only and reset on reload/quit. Workspace paths are not added to saved state.
- Project uses tree/treeitem roles; Status keeps listbox/option roles. Use the observed roles.
