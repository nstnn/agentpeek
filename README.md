# AgentPeek

AgentPeek is a macOS app that shows what your local AI coding agents are doing: which Codex and
Claude Code sessions on your Mac are running, waiting for you, have a new reply, or failed.

It only reads the tools' own local files. It never changes them, never stores conversation text,
and makes no outbound network requests. It runs only while its window is open. The one network
feature, [Remote View](#remote-view-beta), is off by default.

Built with Electron, TypeScript and React. **Status:** Phase 1 is implemented; final acceptance
(sleep/wake, external app actions, a full real-session comparison) is pending.

## Features

- **Views.** Active (running sessions), Inbox (waiting sessions, unread replies and errors),
  Pinned and All Sessions. Reading a reply or error clears it from Inbox.
- **Find Session** (⌘K) searches loaded sessions by title, folder or session ID. It does not read
  conversation content.
- **Pins** keep a session past the 7-day / 50-session limits. If its file disappears, it stays as
  "Unavailable pinned session" until you unpin it.
- **Projects.** Sessions are grouped by working folder by default, Codex and Claude Code together;
  switch to Group by → Status for status sections.
- **Two reading panes.** Right-click a session → Open to the Right, or drag it to the right side.
- **Open Codex** (⌘O) opens the session's thread in Codex; Open Claude opens the session in Claude.app, or only brings Claude to the front for a session run in a terminal.
- **Settings** (⌘,): Appearance (System, Light, Dark), Monitor Codex / Monitor Claude Code, and
  Remote View.
- **Layout.** Collapse the sidebar (⇧⌘B) or hide the session list (⇧⌘L), and drag dividers to
  resize (double-click to reset). The window's size and position are remembered; the layout and
  selection reset on quit.
- **Zoom** from 80% to 150% with ⌘+ / ⌘− / ⌘0, saved for the next launch.

| Shortcut | Action                     | Shortcut | Action        |
| -------- | -------------------------- | -------- | ------------- |
| ⌘1 – ⌘4  | Active, Inbox, Pinned, All | ⌘K       | Find Session  |
| ⌘R       | Reload sessions            | ⌘O       | Open Codex    |
| ⇧⌘B      | Collapse sidebar           | ⇧⌘L      | Hide sessions |
| ⌘+ ⌘− ⌘0 | Zoom                       | ⌘,       | Settings      |

The list, project headings and dividers also work with the arrow keys, Home/End and Enter.

## Remote View (beta)

Remote View lets you check session status from your phone or another computer through your own
[Tailscale](https://tailscale.com/) network. It is a personal beta for one Mac and your own
devices, and it only works while AgentPeek is open on an awake Mac.

- **Shared:** for the projects you pick, each session's tool, status and age, in a read-only
  page laid out like the app. Titles only if you turn on **Share session titles** (otherwise rows
  read `Session 1`, `Session 2`, …).
- **Never shared:** folder paths, your login, the Mac's address, files, tool input or output. The
  page cannot control the tools, pin or mark anything read, and stores nothing in the browser.
- **How it is reached:** AgentPeek listens only on `127.0.0.1` and answers only requests that
  carry your Tailscale login and your Mac's `*.ts.net` address, as Tailscale Serve adds them.
  AgentPeek never installs or configures Tailscale. If Remote View was on when you quit, it
  turns back on when you open the app.

### Set up

Settings → Remote View → **Set up Tailscale** shows the same steps.

1. Install Tailscale on the Mac and each viewing device, signed in to the same account, with
   two-factor sign-in.
2. In the Tailscale admin console, turn on **Tailnet Lock**.
3. Give the Mac a neutral machine name (such as `mac-01`) **before** enabling HTTPS: the name
   becomes public in certificate logs. Then turn on HTTPS certificates (DNS → HTTPS
   Certificates).
4. In AgentPeek, open Settings → Remote View: enter your Tailscale login and
   `<machine>.<tailnet>.ts.net`, keep or change the port (default 47613), **Save**, add projects
   and turn Remote View on.
5. On the Mac, run the command Settings shows, for example:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:47613
   ```

   Never use `tailscale funnel` for this port: it would make it public on the internet.

6. On your phone, open `https://<machine>.<tailnet>.ts.net/`.

### Turn it off

- **Everything:** turn Remote View off in Settings, or run `tailscale serve reset`.
- **Part of it:** remove a project, turn off titles or a source. Open pages update at once.
- **One device:** remove it from your tailnet or block it with ACLs. Changing the allowed login
  in Settings ends every open page.

None of these takes back what a device already showed.

### Recent messages (not yet accepted)

The separate **Share recent messages** switch lets a viewer open one session and read its latest
prompts and replies: at most 20 entries and 64 KB, as plain inert text, tool calls as a count
only. It never sends full history, files, tool input or output, or link targets; a path typed in a
message is sent as written. The switch is off at every launch and turns off when Remote View does.

It has been checked only with synthetic data. Do not use it with real sessions until the device
checks below pass.

### Known limits

- Checked on Safari (iPhone and Mac) through Tailscale Serve and headless Chrome; other browsers
  with streamed `fetch` should work.
- Not yet observed on real devices: phone network loss and lock/unlock, Mac sleep/wake with a page
  open, a fresh load while AgentPeek is closed, refusal of another device or login,
  `tailscale serve reset`, device removal, and the packaged app.
- One report awaits a recheck: titles staying visible on an open iPhone Safari page after Share
  session titles was turned off.
- Any other process on the Mac can reach the loopback port and send the headers Serve adds.
- A Tailscale error page instead of AgentPeek means AgentPeek is closed, or the Mac is asleep or
  offline.

## Development

Requires macOS on Apple Silicon and Node.js 22.13+ (22.x) or 24+.

```bash
npm ci
npm run dev        # development mode with hot reload
npm run build      # build into out/
npm start          # run the build
```

**Synthetic data.** `npm run fixture -- create` prints a synthetic home and state folder. Run with
both, as absolute paths; a run with only one is refused so it cannot fall back to real data:

```bash
AGENTPEEK_HOME=/abs/synthetic-home AGENTPEEK_USER_DATA=/abs/synthetic-state npm start
```

The window then shows a Fixture data banner. See the [fixture guide](scripts/fixture/README.md)
for simulated session changes.

**Package.** `npm run package` builds `dist/mac-arm64/AgentPeek.app` without installing it:
ad-hoc signed, hardened runtime, Node mode and the inspector disabled, code loaded only from the
integrity-checked `app.asar`. There is no updater, Developer ID signing or notarization. Check it
with `codesign --verify --deep --strict dist/mac-arm64/AgentPeek.app` and
`npx --no-install @electron/fuses read --app dist/mac-arm64/AgentPeek.app`.

| Command                       | What it does                                                         |
| ----------------------------- | -------------------------------------------------------------------- |
| `npm run typecheck`           | Type-checks the main process, the renderer and the Remote View page. |
| `npm run lint`                | ESLint, then Prettier formatting check (`npm run format` fixes it).  |
| `npm test`                    | Unit tests (vitest).                                                 |
| `npm run test:remote-web`     | Remote View page tests, including its import boundary.               |
| `npm run test:remote-browser` | Remote View page in headless Chrome through a simulated Serve.       |
| `npm run e2e`                 | Playwright specs against the built app on synthetic data.            |

`npm run e2e` opens app windows; set `AGENTPEEK_E2E_BACKGROUND=1` to keep them invisible and
unfocused while you work (focus is then emulated, so use a normal run for acceptance).

### Project layout

Only the main process touches files and the system; the window shows what it is sent. ESLint
enforces these import rules, and tests sit next to the code as `*.test.ts(x)`.

| Folder              | What runs there                                                     | It may import             |
| ------------------- | ------------------------------------------------------------------- | ------------------------- |
| `src/main/*.ts`     | Electron main process: lifecycle, window, menus                     | Electron, Node.js         |
| `src/main/sessions` | Reading and watching the tools' files, AgentPeek's own state        | Node.js, not Electron     |
| `src/main/remote`   | Remote View listener, limits, settings, sharing policy              | Node.js, not Electron     |
| `src/preload`       | The bridge that exposes `window.agentpeek`                          | Electron `contextBridge`  |
| `src/renderer`      | The React interface in a sandboxed window                           | React only                |
| `src/core`          | Pure logic shared by the other parts                                | No Node.js or Electron    |
| `src/shared`        | Types used on both sides of the bridge                              | No Node.js or Electron    |
| `remote/web`        | The Remote View page, a separate Vite build served to other devices | React and `src/core` only |

## Contributing

[AGENTS.md](AGENTS.md) lists the project rules for anyone changing the code, including coding
agents. The [verification map](.agents/skills/verify-agentpeek/features/README.md) describes how
each feature is checked.

## License

AgentPeek is released under the [MIT License](LICENSE). See [SECURITY.md](SECURITY.md) to report
a vulnerability privately.

AgentPeek is an independent project. It is not affiliated with, endorsed by, or sponsored by
OpenAI or Anthropic. Codex and Claude Code are trademarks of their respective owners.
