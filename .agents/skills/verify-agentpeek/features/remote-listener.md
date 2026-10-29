# Remote View listener

When Remote View is on in AgentPeek's saved settings, AgentPeek listens on `127.0.0.1` at the saved port, which the owner's `tailscale serve` publishes inside their tailnet. It answers only requests that carry the saved Tailscale login and Mac address the way Serve sends them, serves the viewer page and one status stream of redacted status, and ends that stream when AgentPeek quits. It is off by default: a fresh profile opens no socket. The stream shows only the exact folders saved as shared, and a source turned off in Settings leaves it at once. Settings > Remote View turns it on and off and edits the same settings; see [Remote View settings](./remote-settings.md).

## Sub-features

- `remote-off` opens no listening socket on a fresh profile.
- `remote-on` listens on `127.0.0.1` at exactly the saved port when the saved settings say on, and on no other interface.
- `remote-guards` gives a missing or other login, a foreign Host or Origin and any method other than GET a typed error with no session data; a refused `/` gets a fixed page.
- `remote-page` serves the viewer page with its Content Security Policy, and its hashed assets, to the owner's requests.
- `remote-stream` starts every stream with a complete redacted status (folder names, opaque IDs, "Session N" aliases, source health) and sends a heartbeat every 15 s.
- `remote-share` shows only the exact saved folders: the fixture's shared folder with its sessions under aliases, and nothing when no folder is saved.
- `remote-limits` bounds what a client can make it do, before any check of the login: a burst over 20 requests gets `rate-limited`, a sixth stream `busy`, oversize headers and a request too slow to arrive `bad-request`, and a POST with a large body `method-not-allowed` at once without being invited to send it. It still listens only on `127.0.0.1` at the saved port afterwards.
- `remote-source-off` sends a replacement status with a higher `generation` and no rows of a source as soon as it is turned off in Settings.
- `remote-viewer-entry` shows the viewer page's connection states in a browser: Live for the owner; Not allowed or the wrong-address page, with no data and no retry, for another login or Host; Connection lost with the last data dimmed while the listener is gone, then Live again with a full status; Remote View is off with the list cleared; and nothing left in browser storage or history.
- `remote-quit` ends open streams with `end: shutdown` when AgentPeek quits, closes the port and exits cleanly.

## How to get to it (user POV)

- Settings > Remote View (see [Remote View settings](./remote-settings.md)), or, for these recipes, AgentPeek's saved state: `remote-view.json` in its state folder with `enabled: true`, a login, a Mac address, a port and the shared folders. AgentPeek reads it at launch.
- A source is turned off in the window: Settings > Sources > Monitor Codex. A viewer reaches it through the owner's `tailscale serve`; in verification, `curl` sends the headers Serve would add.

## Driving it with agentpeek.mjs

Preconditions:

- The user approved launching AgentPeek for this task. All data is synthetic: a generated fixture home, the login `owner@example.com` and the address `synthetic-mac.example-tailnet.ts.net`.
- A port `<port>` that is free now (for example from `node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"`).
- A state folder `<state>` holding `remote-view.json` with `{"version":1,"enabled":true,"ownerLogin":"owner@example.com","hostName":"synthetic-mac.example-tailnet.ts.net","port":<port>,"sharedWorkspaces":["/Users/synthetic/projects/fixture-demo"],"shareTitles":false}`. The folder is the fixture's only workspace (`CWD` in `scripts/fixture/records.mjs`); it is not a folder on this Mac. For the no-folder check use a second state folder with `"sharedWorkspaces":[]`.
- `npm run fixture -- create`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs launch --label remote-listener --fixture <home> --state <state>` (the build includes the viewer), and `doctor` prints `doctor: OK`.
- Below, `-H "$OWNER"` stands for `-H 'Host: synthetic-mac.example-tailnet.ts.net' -H 'Tailscale-User-Login: owner@example.com'`.

- **Find the listener.** `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN` lists `127.0.0.1:<port>` beside the helper's two debug ports, and nothing on `*` or another address.
- **Guards.** `curl -s -w ' %{http_code}' -H 'Host: synthetic-mac.example-tailnet.ts.net' http://127.0.0.1:<port>/v1/status` prints `{"v":1,"error":"not-allowed"} 403`; with a different `Tailscale-User-Login` also 403; with the owner login and `Host: 127.0.0.1:<port>` `bad-host 421`; with `-H "$OWNER" -H 'Origin: https://evil.example'` `bad-origin 403`; with `-H "$OWNER" -X POST` `method-not-allowed 405`. None of these bodies contains `event:` or a session field. `curl -s -H 'Host: synthetic-mac.example-tailnet.ts.net' http://127.0.0.1:<port>/` prints an HTML page with the sentence "Not allowed. This page only opens for the Tailscale login set in AgentPeek on the Mac." and no script.
- **Page.** `curl -s -D - -H "$OWNER" http://127.0.0.1:<port>/` answers 200 with `Cache-Control: no-store`, a `Content-Security-Policy` header with `default-src 'none'`, `script-src 'self'` and `frame-ancestors 'none'`, and the viewer page. Each `/assets/…` path the page names answers 200 with `Cache-Control: public, max-age=31536000, immutable`.
- **Stream and sharing.** `curl -sN --max-time 17 -H "$OWNER" http://127.0.0.1:<port>/v1/status` prints first one `event: status` frame whose JSON has `"v":1`, `snapshotId`, `generation`, `observedAt`, `sentAt` and `status` with `sources` (Codex and Claude Code `connected`) and one project, `"label":"fixture-demo"`, whose sessions are titled `Session 1`, `Session 2`, … with 22-character IDs, then an `event: heartbeat` frame about 15 s later with the same `snapshotId`. No `Fixture ` title, `/Users/` path, fixture root, login or address appears. Launched with the `"sharedWorkspaces":[]` state instead, the first frame has `"projects":[]`.
- **Limits.**
  - Burst: `seq 30 | xargs -P 30 -I{} curl -s -o /dev/null -w '%{http_code}\n' -H "$OWNER" http://127.0.0.1:<port>/ | sort | uniq -c` counts about 20 `200` and the rest `429`, and nothing else. Right after it, `curl -s -D - -H 'Host: synthetic-mac.example-tailnet.ts.net' http://127.0.0.1:<port>/v1/status` from a client without the login answers `429` with `Retry-After: 5` and `{"v":1,"error":"rate-limited"}`, not `not-allowed`: the rate limit comes first. Wait 3 s before the next step so the limit has refilled.
  - Sixth stream: with five `curl -sN -H "$OWNER" …/v1/status > /dev/null &` running, a sixth prints `{"v":1,"error":"busy"} 503`. Stop the five (`kill %1 %2 %3 %4 %5`).
  - Oversize headers: `curl -s -w ' %{http_code}' -H "$OWNER" -H "X-Pad: $(head -c 17000 /dev/zero | tr '\0' a)" http://127.0.0.1:<port>/v1/status` prints `{"v":1,"error":"bad-request"} 400`; with `head -c 15000` the request is served normally.
  - Body: `head -c 10485760 /dev/zero > <evidence>/body.bin`, then `curl -sv -X POST --data-binary @<evidence>/body.bin -H "$OWNER" http://127.0.0.1:<port>/v1/status` shows `< HTTP/1.1 405`, `Allow: GET` and `method-not-allowed` within a second, and no `HTTP/1.1 100 Continue` line (curl asks with `Expect: 100-continue` for a body this size). Delete `body.bin` afterwards.
  - Slow request: `time nc -d 127.0.0.1 <port>` (connect, send nothing) prints `HTTP/1.1 400` with `{"v":1,"error":"bad-request"}` and ends after about 5-6 s.
  - Afterwards, `lsof` lists the same `127.0.0.1:<port>` and nothing new, and an owner request to `/` answers 200.
  - The per-stream byte budget (`end: slow-consumer` at 512 KiB) cannot be reached with fixture data; it is covered by `src/main/remote/listener-limits.test.ts` only.
- **Source off.** With `curl -sN -H "$OWNER" …/v1/status > <evidence>/remote-source-off.txt` running, open Settings and use `click --role switch --name "Monitor Codex"`. Within a second the file gains a `status` frame with a `generation` higher than the first frame's, `sources.codex` `{"state":"off"}` and no session whose `tool` is `codex`; the Claude Code rows stay. Turn Monitor Codex on again before quitting, so the next run starts with both sources.
- **Quit.** With a `curl -sN -H "$OWNER" …/v1/status` stream still open, choose AgentPeek > Quit AgentPeek (`focus`, then `menu-click "AgentPeek > Quit AgentPeek"`), then `wait-exit`: `cleanExit: true`. The curl output ends with `event: end` and `{"v":1,"type":"end","reason":"shutdown"}`, and the port then refuses connections.
- **Viewer entry.** `npm run test:remote-browser` builds the page and drives it in headless Chrome (no window, no AgentPeek launch) against the real listener behind a loopback proxy that adds the login and Host the way Serve does. It prints `Tests  8 passed (8)`: Live with the folder `shared-demo` and no title, path or login on the page; the fixed Not allowed page for a missing and for a different login with no `/v1/status` request; the fixed wrong-address page for a foreign Host; an open page whose login or Host stops matching shows Not allowed or the wrong address, with no data and no further request for 2-3 s; a stopped listener shows `Connection lost · showing data from …` with the list dimmed and the Tailscale-error hint, and a restarted one with a second folder shows Live with `later-demo`; `end: remote-off` shows `Remote View is off` with the list cleared, then Live after a restart; storage, cookies, caches and IndexedDB stay empty and no history entry is added.
- **Off.** Launch a fresh run without `--state`. `lsof` lists only the helper's debug ports.

## Gotchas

- `curl` sends `Host: 127.0.0.1:<port>` unless told otherwise, which the listener refuses with `bad-host` by design; always pass the Mac address as Host.
- The login header is trusted as Serve's: any process on the Mac can send it. That is why every run uses synthetic data and a synthetic login.
- If `<port>` is taken when AgentPeek starts, nothing listens and it does not try another port; pick a new port and relaunch.
- A checkout without the viewer build answers `/` with `{"v":1,"error":"not-found"}`; `npm run build` builds it.
- The helper's `--remote-debugging-port=0` and `--inspect=0` also listen on loopback; tell them apart by port.
- The rate limit is global, 10 requests a second with a burst of 20. Run the limit checks last, or wait a few seconds after the burst, or the next check gets `429` instead of its own answer.
- `test:remote-browser` uses the installed Google Chrome through Playwright's `chrome` channel with a fresh temporary profile; it fails at launch without Chrome. Its page sets `Math.random` low so reconnects come within a second; real pages wait up to 30 s.
- `stop` deletes the copied state folder; the original `<state>` folder stays and is synthetic.
