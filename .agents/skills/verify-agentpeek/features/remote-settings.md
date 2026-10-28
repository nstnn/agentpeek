# Remote View settings

Settings has a Remote View section below Sources. It holds the Remote View switch with a status line, the Connection fields (Tailscale login, Mac address, port) with explicit Save and Cancel, the Shared projects list with Add Project…, the Share session titles switch, a plain list of what leaves the Mac, and a "Set up Tailscale" disclosure with the owner's steps and a Copy button for the `tailscale serve` command. Remote View is off on a fresh install and its switch stays disabled until a login and Mac address are saved. AgentPeek never runs, reads or configures Tailscale; the steps are text to copy.

## Sub-features

- `remote-settings-default`: a fresh profile shows the switch off and disabled with "Add your Tailscale login and Mac address to turn on Remote View.", the default port 47613, no shared project, titles off, and opens no listening socket.
- `remote-settings-invalid`: Save with an invalid login, address or port shows the inline message under each field and saves nothing; Cancel restores the saved values.
- `remote-settings-save`: valid values save, "Saved." appears, the switch becomes available and the viewer address line shows `https://<address>/`.
- `remote-settings-on`: turning the switch on with no shared project listens on `127.0.0.1` at the saved port and says "No projects shared yet, so the page shows an empty list."; a stream's first status has `"projects":[]` (A02). Turning it off says "Off. Nothing is shared." and closes the port.
- `remote-settings-port-in-use`: turning on while the saved port is taken by another process shows "Port <port> is already used by another app. …", leaves the switch off and tries no other port.
- `remote-settings-projects`: Add Project… lists the fixture's folder by name with its parent path; adding it shows it under Shared projects and the stream gains it; Remove takes it out of the stream at once.
- `remote-settings-titles`: Share session titles turns on and off with its confirmation line.
- `remote-settings-setup`: the disclosure names Tailnet Lock, a neutral machine name, HTTPS certificates, the `tailscale serve --bg --https=443 http://127.0.0.1:<port>` command with the saved port, the Funnel warning and the disable path; Copy puts exactly that command on the clipboard.
- `remote-settings-modal`: focus stays inside Settings while moving through the new controls, and returns to the Settings button on close.

## How to get to it (user POV)

- Open Settings (sidebar Settings button, rail gear, AgentPeek > Settings… or Command-comma) and scroll to Remote View below Sources.
- Type in Tailscale login, Mac address and Port, then Save (or press Return in a field) or Cancel.
- Click the Remote View switch, Add Project… and a folder in its list, Remove beside a shared folder, and the Share session titles switch.
- Open "Set up Tailscale" and click Copy beside the command or beside the viewer address.

## Driving it with agentpeek.mjs

Preconditions:

- The user approved launching AgentPeek for this task. All data is synthetic: a generated fixture home (`npm run fixture -- create`), the login `owner@example.com` and the address `synthetic-mac.example-tailnet.ts.net`. Never type a real login or tailnet name.
- A free port `<port>` (see [Remote View listener](./remote-listener.md)) and, for the port-in-use check, a second free port `<busy>` held by `node -e "require('net').createServer().listen(<busy>,'127.0.0.1')" &` before the switch is clicked.
- `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs launch --label remote-settings --fixture <home>` without `--state`, and `doctor` prints `doctor: OK`. Open Settings with `click --role button --name "Settings"`.
- Below, `-H "$OWNER"` stands for `-H 'Host: synthetic-mac.example-tailnet.ts.net' -H 'Tailscale-User-Login: owner@example.com'`.

- **Default (`remote-settings-default`).** Save `aria remote-settings-default` and `screenshot remote-settings-default`. The tree has a region "Remote View" with a switch "Remote View" that is unchecked and disabled, the status text above, textboxes "Tailscale login" (empty), "Mac address" (empty) and "Port" (`47613`), "No projects shared." and an unchecked "Share session titles" switch. `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN` lists only the helper's two debug ports, and the run's state folder has no `remote-view.json`.
- **Invalid (`remote-settings-invalid`).** `click --role textbox --name "Tailscale login"`, `type "not a login"`; Mac address `type "mac.local"`; Port: select its text and `type "80"`. `click --role button --name "Save"`. `aria remote-settings-invalid` shows "Enter a login like you@example.com.", "Enter the full name ending in .ts.net." and "Use a port from 1024 to 65535.", each field invalid; still no `remote-view.json`. `click --role button --name "Cancel"`: the fields show empty, empty and `47613` again.
- **Save (`remote-settings-save`).** Type `owner@example.com`, `synthetic-mac.example-tailnet.ts.net` and `<port>`, then Save. `aria remote-settings-saved` shows "Saved.", the status "Off. Nothing is shared.", an enabled unchecked switch and "Viewer address: https://synthetic-mac.example-tailnet.ts.net/". The state folder's `remote-view.json` holds exactly `version`, `enabled` (false), `ownerLogin`, `hostName`, `port`, `sharedWorkspaces` (`[]`) and `shareTitles` (false), and its mode is `-rw-------`.
- **On and off (`remote-settings-on`).** `click --role switch --name "Remote View"`. `aria remote-settings-on` shows the switch checked and "On, port <port>. No projects shared yet, so the page shows an empty list." `lsof` lists `127.0.0.1:<port>`; `curl -sN --max-time 3 -H "$OWNER" http://127.0.0.1:<port>/v1/status` prints a first `status` frame with `"projects":[]` and no session field. Click the switch again: "Off. Nothing is shared.", the switch unchecked, and the port refuses connections.
- **Port in use (`remote-settings-port-in-use`).** With `<busy>` held, change Port to `<busy>`, Save, then click the switch. `aria remote-settings-port-in-use` shows the switch unchecked and "Port <busy> is already used by another app. Choose another port, save, and turn Remote View on again." `lsof` for AgentPeek lists no `<busy>` and no other new port. Stop the holder, set Port back to `<port>` and Save: "Saved." stays about 3 s and the status line says "Off. Nothing is shared." (the old error does not repeat with the new port).
- **Projects (`remote-settings-projects`).** Turn Remote View on and keep `curl -sN -H "$OWNER" …/v1/status > <evidence>/remote-settings-projects.txt` running. `click --role button --name "Add Project…"`: the list "Project folders" has one button `fixture-demo` with `/Users/synthetic/projects/` beside it. Click it: Shared projects lists `fixture-demo` with "Remove fixture-demo", the status says "Sharing 1 project." or counts the curl stream as "1 viewer page open.", and the file gains a `status` frame with `"label":"fixture-demo"` and `Session N` titles. `click --role button --name "Remove fixture-demo"`: within a second the file gains a frame with a higher `generation` and `"projects":[]`.
- **Titles (`remote-settings-titles`).** `click --role switch --name "Share session titles"`: checked, "Titles are shared."; click again: unchecked, "Titles are hidden; sessions show as 'Session N'."
- **Setup (`remote-settings-setup`).** `click --selector ".remote-setup summary"`, then `aria remote-settings-setup` and `screenshot remote-settings-setup`: the steps mention Tailnet Lock, a neutral machine name, HTTPS Certificates, `tailscale serve --bg --https=443 http://127.0.0.1:<port>`, "Never use tailscale funnel for this port" and `tailscale serve reset`. Click the Copy button in that step; the button reads "Copied", and `main-eval "electron.clipboard.readText()"` returns exactly the command with `<port>`. This overwrites the Mac's clipboard; say so in the report.
- **Modal (`remote-settings-modal`).** Press Tab repeatedly from the Close Settings button through the Remote View controls; after each press `eval "document.activeElement?.closest('dialog') !== null"` is `true`. `key Escape` closes Settings and focus returns to the Settings button.
- Turn Remote View off before quitting, then quit with `focus` and `menu-click "AgentPeek > Quit AgentPeek"`, and `wait-exit`: `cleanExit: true`.

## Gotchas

- Settings scrolls; the Remote View section is below Sources and may need `scroll_to`-style focus (Tab) before a screenshot shows it.
- The status line updates when the window gets a new snapshot or after an action; a viewer page opened with `curl` may take until the next snapshot to be counted.
- `type` inserts at the caret: select a field's text first (`key Meta+A`) to replace the port.
- Add Project… lists only folders of sessions AgentPeek shows; the fixture has one folder.
- Copy writes to the Mac's real clipboard (there is no isolated one).
- The rate limit (20 requests burst) applies to the curl checks; space them out as in [Remote View listener](./remote-listener.md).
