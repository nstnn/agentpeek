# Remote View listener

When Remote View is on in AgentPeek's saved settings, AgentPeek listens on `127.0.0.1` at the saved port, which the owner's `tailscale serve` publishes inside their tailnet. It answers only requests that carry the saved Tailscale login and Mac address the way Serve sends them, serves the viewer page and one status stream of redacted status, and ends that stream when AgentPeek quits. It is off by default: a fresh profile opens no socket. There is no window control for it yet; Settings > Remote View comes with TASK-016.

## Sub-features

- `remote-off` opens no listening socket on a fresh profile.
- `remote-on` listens on `127.0.0.1` at exactly the saved port when the saved settings say on, and on no other interface.
- `remote-guards` gives a missing or other login, a foreign Host or Origin and any method other than GET a typed error with no session data; a refused `/` gets a fixed page.
- `remote-page` serves the viewer page with its Content Security Policy, and its hashed assets, to the owner's requests.
- `remote-stream` starts every stream with a complete redacted status (folder names, opaque IDs, "Session N" aliases, source health) and sends a heartbeat every 15 s.
- `remote-quit` ends open streams with `end: shutdown` when AgentPeek quits, closes the port and exits cleanly.

## How to get to it (user POV)

- Today only through AgentPeek's saved state: `remote-view.json` in its state folder with `enabled: true`, a login, a Mac address and a port. AgentPeek reads it at launch. A viewer reaches it through the owner's `tailscale serve`; in verification, `curl` sends the headers Serve would add.

## Driving it with agentpeek.mjs

Preconditions:

- The user approved launching AgentPeek for this task. All data is synthetic: a generated fixture home, the login `owner@example.com` and the address `synthetic-mac.example-tailnet.ts.net`.
- A port `<port>` that is free now (for example from `node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"`).
- A state folder `<state>` holding `remote-view.json` with `{"version":1,"enabled":true,"ownerLogin":"owner@example.com","hostName":"synthetic-mac.example-tailnet.ts.net","port":<port>}`.
- `npm run fixture -- create`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs launch --label remote-listener --fixture <home> --state <state>` (the build includes the viewer), and `doctor` prints `doctor: OK`.
- Below, `-H "$OWNER"` stands for `-H 'Host: synthetic-mac.example-tailnet.ts.net' -H 'Tailscale-User-Login: owner@example.com'`.

- **Find the listener.** `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN` lists `127.0.0.1:<port>` beside the helper's two debug ports, and nothing on `*` or another address.
- **Guards.** `curl -s -w ' %{http_code}' -H 'Host: synthetic-mac.example-tailnet.ts.net' http://127.0.0.1:<port>/v1/status` prints `{"v":1,"error":"not-allowed"} 403`; with a different `Tailscale-User-Login` also 403; with the owner login and `Host: 127.0.0.1:<port>` `bad-host 421`; with `-H "$OWNER" -H 'Origin: https://evil.example'` `bad-origin 403`; with `-H "$OWNER" -X POST` `method-not-allowed 405`. None of these bodies contains `event:` or a session field. `curl -s -H 'Host: synthetic-mac.example-tailnet.ts.net' http://127.0.0.1:<port>/` prints an HTML page with the sentence "Not allowed. This page only opens for the Tailscale login set in AgentPeek on the Mac." and no script.
- **Page.** `curl -s -D - -H "$OWNER" http://127.0.0.1:<port>/` answers 200 with `Cache-Control: no-store`, a `Content-Security-Policy` header with `default-src 'none'`, `script-src 'self'` and `frame-ancestors 'none'`, and the viewer page. Each `/assets/…` path the page names answers 200 with `Cache-Control: public, max-age=31536000, immutable`.
- **Stream.** `curl -sN --max-time 17 -H "$OWNER" http://127.0.0.1:<port>/v1/status` prints first one `event: status` frame whose JSON has `"v":1`, `snapshotId`, `generation`, `observedAt`, `sentAt` and `status` with `sources` (Codex and Claude Code `connected`) and `"projects":[]` (no project is shared until TASK-015), then an `event: heartbeat` frame about 15 s later with the same `snapshotId`. No `Fixture ` title, `/Users/` path, fixture root, login or address appears.
- **Quit.** With a `curl -sN -H "$OWNER" …/v1/status` stream still open, choose AgentPeek > Quit AgentPeek (`focus`, then `menu-click "AgentPeek > Quit AgentPeek"`), then `wait-exit`: `cleanExit: true`. The curl output ends with `event: end` and `{"v":1,"type":"end","reason":"shutdown"}`, and the port then refuses connections.
- **Off.** Launch a fresh run without `--state`. `lsof` lists only the helper's debug ports.

## Gotchas

- `curl` sends `Host: 127.0.0.1:<port>` unless told otherwise, which the listener refuses with `bad-host` by design; always pass the Mac address as Host.
- The login header is trusted as Serve's: any process on the Mac can send it. That is why every run uses synthetic data and a synthetic login.
- If `<port>` is taken when AgentPeek starts, nothing listens and it does not try another port; pick a new port and relaunch.
- A checkout without the viewer build answers `/` with `{"v":1,"error":"not-found"}`; `npm run build` builds it.
- The helper's `--remote-debugging-port=0` and `--inspect=0` also listen on loopback; tell them apart by port.
- `stop` deletes the copied state folder; the original `<state>` folder stays and is synthetic.
