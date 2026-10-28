# Localhost preview (development only)

With a development switch and synthetic fixture data, AgentPeek also serves its Remote View status on a page at `http://127.0.0.1:<port>/` on this Mac, and keeps it current. Without the switch, or on real data, it opens no network socket at all. The page is a stub that shows the redacted status as text until TASK-038 designs it.

## Sub-features

- `preview-off` opens no listening socket without the switch, and none on a real home even with it.
- `preview-url` prints the page URL to the development terminal, bound to 127.0.0.1 only.
- `preview-stream` shows redacted status (folder names, opaque IDs, "Session N" aliases) that updates as fixture sessions change; no title, path or raw ID appears.
- `preview-guards` refuses a foreign Host or Origin and any method other than GET.
- `preview-quit` closes the listener when AgentPeek quits, even with a page still open.

## How to get to it (user POV)

- A developer launches AgentPeek on a fixture home with `AGENTPEEK_REMOTE_PREVIEW=1` and opens the printed URL in a browser on the same Mac. There is no menu, setting or window control for it.

## Driving it with agentpeek.mjs

Preconditions:

- The user approved launching AgentPeek and opening the preview URL for this task.
- A fresh run with the switch on a generated fixture: `npm run fixture -- create`, then `AGENTPEEK_REMOTE_PREVIEW=1 node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs launch --label localhost-preview --fixture <home>`, and `doctor` prints `doctor: OK`.

- **Find the page.** Read the run's `app.log` in its evidence folder. It contains one line `AgentPeek localhost preview: http://127.0.0.1:<port>/`. `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN` lists that port on `127.0.0.1` only, beside the debug ports the helper itself opens.
- **See the status.** Run `curl -sN --max-time 2 http://127.0.0.1:<port>/events`. It prints `event: status` frames whose JSON has only `observedAt`, `sources`, `projects` and `omitted`; the project label is `fixture-demo` and titles are `Session N`. No `Fixture ` title, `/Users/` path or fixture home path appears.
- **Guards.** `curl -s -o /dev/null -w '%{http_code}' -H 'Host: localhost:<port>' http://127.0.0.1:<port>/` prints `421`; with `-H 'Origin: http://evil.example'` it prints `403`; with `-X POST` it prints `405`.
- **Live update.** Keep a `curl -sN` stream open, apply `npm run fixture -- simulate <copied homeDir> codex-complete`, and a new frame arrives within about a second with the changed activity.
- **Quit.** With the stream still open, choose AgentPeek > Quit AgentPeek (`menu-click`), then `wait-exit`: `cleanExit: true`, the curl stream ends, and the port no longer accepts connections.
- **Switch off.** Launch a fresh run without the variable. `lsof` lists only the helper's debug ports and `app.log` has no preview line.

## Gotchas

- The helper's `--remote-debugging-port=0` and `--inspect=0` also listen on loopback; tell them apart from the preview port by the `app.log` line.
- The endpoint has no authentication: any local process can read it. That is why it refuses to start on real data. Never set the switch on a run with real data.
- `simulate` must target the helper's copied `homeDir` from `run.json`, not the original fixture.
- `curl` sends no Origin header, which the server allows for same-origin requests; only a present, foreign Origin is refused.
