# AgentPeek

AgentPeek is a macOS app that shows what your local AI coding agents are doing. Open it to see which Codex and Claude Code sessions on your Mac are running, waiting for you, have a new reply, or failed. It only reads the tools' own local files: it never changes them, never stores conversation text, and makes no outbound network requests. The one network feature, [Remote View](#remote-view-status-beta), is off by default; when you turn it on, AgentPeek listens on `127.0.0.1` so your own devices can see session status through your Tailscale.

AgentPeek is built with Electron, TypeScript, and React.

The first launch maximizes the window within the display's work area. On normal close or quit,
AgentPeek remembers the window's size, position, maximized state and macOS Full Screen choice
for the next launch. If a display is disconnected, the restored window fits an available display.

**Status: Phase 1 implemented; final acceptance pending.** The app has live session lists,
Active/Pinned/All Sessions views, tool filters, source health, safe message detail, pin/read
actions, two session panes, keyboard navigation and a local macOS package. Automated tests and approved synthetic
built-app checks cover the implemented paths. Physical sleep/wake, external app/browser actions
and a complete real-session comparison still need acceptance evidence. VoiceOver speech is not
part of acceptance: AgentPeek is a personal tool and its owner does not use a screen reader.

Sessions are grouped by **Project** by default. Click a project heading to collapse or expand it;
its count, attention and running summaries stay visible while collapsed. **Group by → Status**
restores the status sections. Projects use the full working-folder path, combine Codex and
Claude Code sessions in the same folder, and keep different worktrees separate. Duplicate folder
names show their full paths; sessions without a folder appear under **No folder**. Project order
is stable by path; sessions within a project keep pinned/recent ordering. Views and tool filters
apply before grouping. Grouping and collapsed projects are remembered until quit/reload.
Use Up/Down/Home/End to navigate projects and sessions, Left/Right to collapse/expand or enter a
project, and Enter/Space to toggle a project or open a session. Collapsing a project clears its
list cursor while preserving any session already open in either reading pane.

Right-click a session and choose **Open to the Right**, or drag its row into the right-side
preview to split the view. Once split, the context menu and drag previews can replace either
**Left pane** or **Right pane**. Clicking or focusing a pane makes it active; ordinary row
clicks open in that pane. The active pane has a labeled
accent header showing its session title once; the metadata below starts with the tool and workspace. Escape or an outside drop cancels a drag without changing either session.
Only a successfully loaded, active visible reply/error is marked read while the window is
focused; waiting still requires action in the tool.

Click the icon beside **Sessions** (⇧⌘B) to collapse the sidebar to a 56-pixel icon rail.
The icon beside **Active**, **Pinned** or **All Sessions** (⇧⌘L) independently hides the
session list. Its restore icon appears in the reading header while the list is hidden.
Both controls use the existing headers, without a separate navigation toolbar or extra labels.
**Settings** stays at the bottom of the sidebar, including its collapsed icon rail. Open it
there or with **AgentPeek → Settings…** (⌘,) to choose **System**, **Light** or **Dark** under
Appearance. System is the default. Changes apply immediately and are saved for the next launch;
**Sources** in Settings has independent **Monitor Codex** and **Monitor Claude Code** switches.
Both start on. Turning one off stops its file monitoring and message reads, hides its sessions
and counts, and retains pins/read markers. An open reading pane shows Monitoring off; turn the
source back on to rediscover its current sessions. These choices are saved across launches.
Close or Escape returns to the same sessions and scroll positions. While Settings is open,
covered conversations do not automatically acknowledge new replies. A failed preference save
restores the previous appearance and shows a retry message.

**View → Zoom In / Zoom Out / Actual Size** scales the whole interface with ⌘+ (also ⌘=),
⌘− and ⌘0. Zoom uses exact 10-point steps from 80% to 150%, defaults to 100%, and is saved
independently of Theme for the next launch. A brief notice and the View menu show the percentage.
Zoom also works while Settings is open. Larger zoom can switch to the existing compact layout;
it retains the selected sessions. A failed save restores the previous zoom and shows a retry message.

Navigation slides over 220 ms with a gentle deceleration; Reduce Motion makes it immediate.
Connected tools appear as a dot and name directly above Settings; the rail uses their initials.
Click a connected source to open Settings, where all tools and their current status are shown.
With no connected source, the expanded sidebar shows No sources connected. The rail keeps
Active attention counts and view selection. Choosing a view opens
its filtered list while retaining the sessions being read.

The layout uses the remaining width after navigation: with the default 190-pixel sidebar,
single-pane reading fits beside the list at 800+ content pixels, two split details fit at
840+, and the list fits alongside both at 1125+. Collapsing Views lowers those thresholds
to 661/701/982 pixels. Resizing a preferred sidebar changes the thresholds accordingly.
When the list replaces reading, **Hide Sessions** resumes the remembered pane; below the
two-detail capacity, buttons labeled with session titles select one detail at a time.
Each pane keeps its scroll and disclosures across toggles and resizing. Each split pane
has an **×** button; closing either keeps the other session in the single-pane layout.
The layout, navigation visibility and selected sessions reset when the app quits or reloads.

Drag the divider between visible columns to resize the sidebar, sessions list or either
conversation pane. Sizes stay within readable limits and are remembered until quit/reload.
Double-click a divider to reset it. With a divider focused, Left/Right adjusts by 10 pixels
(Shift: 40), Home/End reaches its limits, and Enter resets it. Escape cancels an ongoing resize.

## Remote View (status beta)

Remote View lets you check session status from your phone or another computer, using your own
[Tailscale](https://tailscale.com/) network. It is a personal beta: one Mac, your own devices,
and only the projects you pick. It is not a public release.

**What it shows.** A read-only list of the sessions in the projects you share: tool, status
(running, waiting, new reply, failed) and age, laid out like the AgentPeek window: on a wide
screen a sidebar (Active, All Sessions, sources), the list grouped by status or by project folder
name with a Codex / Claude Code filter, and the session detail beside it; on a phone the list,
with the sidebar behind a menu button. Session titles appear only when you turn on **Share session titles**;
otherwise rows are named `Session 1`, `Session 2`, … and the Mac's session detail shows the
matching "Remote: Session N" line. Message text appears only while you turn on **Share recent
messages** (see [Recent messages](#recent-messages-not-yet-accepted)). The page never shows folder
paths, your login or the Mac address, and it cannot control the tools, pin, or mark anything read.

**What it does not do.** AgentPeek makes no outbound requests and never runs, installs or
configures Tailscale. It listens only on `127.0.0.1` and answers only requests that carry your
Tailscale login and your Mac's `*.ts.net` address, as Tailscale Serve adds them. It has no
background process: viewing works only while AgentPeek is open on an awake Mac. If AgentPeek was
on when you quit, it turns Remote View back on when you open the app again.

### Set up

Do these steps yourself; Settings > Remote View > **Set up Tailscale** shows the same list.

1. Install Tailscale on the Mac and on each device you want to view from, and sign in with the
   same account everywhere. Turn on two-factor sign-in with your login provider.
2. In the Tailscale admin console, turn on **Tailnet Lock**, so no new device can join without a
   signature from one of yours.
3. Give the Mac a neutral machine name (for example `mac-01`) **before** turning on HTTPS: the name
   becomes public in certificate logs.
4. In the admin console, turn on HTTPS certificates (DNS → HTTPS Certificates).
5. In AgentPeek, open **Settings > Remote View**, enter your Tailscale login and the Mac's address
   (`<machine>.<tailnet>.ts.net`), keep or change the port (default 47613), **Save**, add the
   projects to share and turn Remote View on.
6. In Terminal on the Mac, run the command that Settings shows and copies, for example:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:47613
   ```

   Never use `tailscale funnel` for this port: Funnel makes it public on the internet.

7. On your phone, with Tailscale connected, open `https://<machine>.<tailnet>.ts.net/`.

While Remote View is on, the sidebar shows **Remote View on**, and Settings shows how many viewer
pages are open.

### Recent messages (not yet accepted)

**Share recent messages** in Settings > Remote View lets a viewer page open one session and read
its latest prompts and replies. It is off when AgentPeek opens, every time, and it can be on only
while Remote View is on. It turns itself off when you quit, turn Remote View off or save a new
connection. While it is on, conversation text leaves the Mac, and the sidebar shows **Remote View
on / Messages shared**.

- **What a page gets:** for the session it opens, at most the latest 20 prompts and replies and
  at most 64 KB of text. Older entries are dropped first ("Only the latest messages are shown.")
  and a long entry is cut ("Shortened to fit."). Tool calls show as a count only.
- **What it never gets:** full history, files, tool input or output, skill content, or link
  targets. A link shows as its text only. A path written in a message itself is sent as written.
- **On the page:** with the switch on, session rows become buttons. Text is shown as plain,
  inert formatting: nothing in it loads, runs or links anywhere. **Back to sessions** and the
  browser or phone Back both return to the list. The page keeps the text in memory only, never
  in storage, the address or history.
- **When it stops:** turning the switch off, turning Remote View off, removing the project,
  turning the source off, changing the allowed login, closing the page and quitting AgentPeek
  each remove the text from open pages at once. Nothing takes back text a device already showed.

This part is checked only with synthetic data on the Mac (built app and Chrome through a
simulated Serve). It is not yet accepted for real use: the device checks listed under
[Known limits](#known-limits) must pass on your own devices first.

### Browsers

Checked: Safari on iPhone and Safari on macOS through Tailscale Serve, and headless Chrome against
a simulated Serve. Other current browsers that support streamed `fetch` should work but have not
been checked. The page keeps everything in memory only: no storage, cookies or caches. If you see
a Tailscale error page instead of AgentPeek, AgentPeek is closed, or the Mac is asleep or offline.

### Turn it off or remove a device

- **Stop all remote viewing:** turn Remote View off in Settings. Open pages show "Remote View is
  off" and the port closes. You can also run `tailscale serve reset`; either one alone stops
  remote viewing. Local use of AgentPeek is unaffected.
- **Stop sharing something:** remove a project, turn off Share session titles, or turn off a
  source. Open pages update at once.
- **Stop one device:** remove it from your tailnet in the Tailscale admin console, or change your
  access controls (ACLs) so it cannot reach the Mac. Changing the allowed login in Settings ends
  every open page.

None of these takes back what a device already showed or what was copied from it.

### Known limits

Accepted with synthetic data in the built desktop app, and on the owner's own Tailscale with
Safari on a Mac and an iPhone. Not yet observed: phone network loss, lock/unlock and Mac
sleep/wake with a page open; a fresh load while AgentPeek is closed; refusal of an outside device
or login through the real path; `tailscale serve reset` and device removal on the real path;
and the packaged app. Two reports await a recheck: titles staying visible on an open
iPhone Safari page after Share session titles was turned off, and helper processes taking more
than 5 seconds to exit after Quit. Any other process on the Mac can reach the loopback port and
send the same headers that Serve adds. Recent messages stay not accepted, and not for real use,
until the device checks above (allowed-login change, `tailscale serve reset`, quit and reopen with
the phone page open, phone lock/unlock and network loss, Mac sleep/wake, and the titles recheck)
pass on your own devices; they have also not been tried on a phone or in Safari.

## Requirements

- macOS on Apple Silicon
- Node.js 22.13+ in the 22.x line, or Node.js 24+, with npm (the packaging fuse tool requires 22.12+)

## Set up

```bash
npm ci
```

## Run

Start AgentPeek in development mode, with hot reload:

```bash
npm run dev
```

Build it into `out/`, then run the build:

```bash
npm run build
```

```bash
npm start
```

Agent runs use synthetic data. Provide both absolute paths together; incomplete fixture overrides
are rejected so a fixture run cannot fall back to real sessions or real saved state:

```bash
AGENTPEEK_HOME=/absolute/path/to/synthetic-home AGENTPEEK_USER_DATA=/absolute/path/to/synthetic-state npm start
```

Fixture mode shows a persistent banner naming the synthetic home. Its process checks treat fixture
tools and registry owners as alive; it never checks the user's running tools.
Create the synthetic home and state paths with `npm run fixture -- create`; see the
[fixture guide](scripts/fixture/README.md) for simulation and cleanup. Both `npm run dev` and
`npm start` open a window. Agent-run launches require approval for the current task.

## Package

Build a local Apple Silicon app without launching it:

```bash
npm run package
```

The result is `dist/mac-arm64/AgentPeek.app`, versioned from `package.json`, with a placeholder
icon and About panel. The bundle is ad-hoc signed with hardened runtime and the required Electron
fuses: Node mode, `NODE_OPTIONS`, and the main-process inspector are disabled; code loads only
from the integrity-checked `app.asar`. It has no updater, publishing, Developer ID signing, or
notarization. This is a local build; the command does not install it into `/Applications`.

Inspect the build without opening a window:

```bash
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/AgentPeek.app
codesign -dv --verbose=4 dist/mac-arm64/AgentPeek.app
npx --no-install @electron/fuses read --app dist/mac-arm64/AgentPeek.app
```

The ad-hoc hardened runtime needs JIT and library-validation entitlements for Electron on arm64;
these live in `build/entitlements.mac.plist`. The renderer's sandbox and process boundary still
apply. Use the unpackaged `out/` build for Playwright and the verification helper, because the
packaged app disables the inspector. Agent-run packaged checks need launch approval and both
synthetic fixture overrides, just like development runs.

## Check

| Command                       | What it does                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `npm run typecheck`           | Type-checks the main process, the renderer and the Remote View page separately.                     |
| `npm run lint`                | Runs ESLint, then checks formatting with Prettier.                                                  |
| `npm test`                    | Runs the unit tests with vitest.                                                                    |
| `npm run test:remote-web`     | Runs only the Remote View page's tests, including its import-boundary check.                        |
| `npm run build:remote-web`    | Builds only the Remote View page into `out/remote-web/` (`npm run build` includes it).              |
| `npm run test:remote-browser` | Checks the Remote View page in headless Chrome through a simulated Tailscale Serve (needs Chrome).  |
| `npm run fixture -- create`   | Creates an isolated synthetic home for regression checks.                                           |
| `npm run e2e`                 | Opens the built app twice for the Playwright fixture smoke; build first and obtain launch approval. |
| `npm run format`              | Rewrites files in the Prettier style.                                                               |

The [fixture guide](scripts/fixture/README.md) lists the simulator commands and expected states.
The smoke checks bootstrap, a live update within 2 seconds, safe detail rendering, independent
Main/Second selection, inactive/hidden reply isolation, compact Back/Return, close-to-single,
layout reset on relaunch, persisted pins and requests limited to the app's renderer files.
It uses temporary fixture/profile folders,
removes them after the run, and retains evidence in ignored `test-results/e2e/`. It does not
replace manual system, accessibility, packaged-build or consented real-data acceptance.

To keep using the Mac during a run, set `AGENTPEEK_E2E_BACKGROUND=1`, for example
`AGENTPEEK_E2E_BACKGROUND=1 npm run e2e`. The test window is then invisible, ignores the
mouse except during a spec's own drag, never takes focus and has no Dock icon. The test
bootstrap reports the window as focused instead. Because focus is emulated, a normal run is
still needed for acceptance evidence.

## Project layout

AgentPeek follows Electron's process model. Only the main process touches files and the system; the window shows what the main process sends it.

| Folder              | What runs there                                                                                               | It may import                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `src/main/*.ts`     | Electron main process: app lifecycle, window, menus                                                           | Electron, Node.js                  |
| `src/main/sessions` | Reading and watching the tools' files, the sessions service, and saving AgentPeek's own state (plain Node.js) | Node.js, but not Electron          |
| `src/main/remote`   | Remote View: the opt-in loopback listener, its limits, settings, sharing policy, lifecycle, the dev preview   | Node.js, but not Electron          |
| `src/preload`       | The bridge that exposes `window.agentpeek`                                                                    | Electron's `contextBridge`         |
| `src/renderer`      | The React interface, in a sandboxed window, including Settings > Remote View                                  | React, but not Node.js or Electron |
| `src/core`          | Pure logic shared by the other parts                                                                          | Nothing from Node.js or Electron   |
| `src/shared`        | Types used on both sides of the bridge                                                                        | Nothing from Node.js or Electron   |
| `remote/web`        | The Remote View page, a separate Vite build served by the listener to a browser on another device             | React and `src/core` only          |

ESLint enforces the import rules. Tests sit next to the code they test, as `*.test.ts` or `*.test.tsx`. Renderer and Remote View page component tests use Testing Library in jsdom; source and main-process tests use Node.js.

## Contributing

[AGENTS.md](AGENTS.md) lists the project-wide rules for anyone changing the code, including coding agents.

The local documentation set contains `docs/REQUIREMENTS.md` (implemented behavior, scope and
acceptance limits), `docs/ARCHITECTURE.md` (processes, data flow and security), and
`plan/agent-sessions/evidence/acceptance.md` (the Phase 1 acceptance record). `docs/` and `plan/`
are intentionally ignored by Git and may be absent in another checkout. The versioned
[verification map](.agents/skills/verify-agentpeek/features/README.md) and fixture guide remain
available there.
