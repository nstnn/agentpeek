# Renderer lockdown

Whatever the window displays, its page has no direct file, system, or network access. It has no Node.js and uses only the typed `window.agentpeek` bridge for validated session requests, appearance preferences and explicit actions such as opening a tool or a web link. It cannot navigate away, open windows, load remote content, run `eval` or injected scripts, or get permissions such as notifications or the camera. Users rely on this when AgentPeek shows text written by agents, links, and Markdown.

## Sub-features

- `bridge-only` exposes exactly the 15 named capabilities below, without a raw IPC transport, Electron event, `require`, `process`, `module`, or `Buffer`.
- `validated-requests` rejects foreign senders, child frames, extra arguments, invalid keys/tools/limits/booleans/themes, and unsafe links before any side effect; request failures omit source text.
- `no-navigation` keeps the page on AgentPeek's own file after a navigation attempt.
- `no-new-windows` makes `window.open` return `null` and opens no window.
- `no-remote-loads` blocks remote requests and images through the Content Security Policy before any request is made.
- `no-eval` blocks `eval` and injected inline scripts.
- `no-permissions` denies notification and camera permissions without a prompt.

## How to get to it (user POV)

- There is no menu or button for it. It applies to everything the page shows, for example a link or hostile Markdown inside an agent's message once sessions are displayed.

## Driving it with agentpeek.mjs

Preconditions:

- A fresh run from `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs launch --label lockdown`, and `doctor` prints `doctor: OK`.
- Run this feature last in a run: its steps log CSP violations on purpose, after which `doctor` fails `no console errors`.

Each step runs script inside the page, which is exactly what hostile content would do.

- **Bridge only.** Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs eval "({ bridge: Object.keys(window.agentpeek).sort(), require: typeof require, process: typeof process, module: typeof module, Buffer: typeof Buffer })"`. The bridge is exactly `["copySessionId", "getMessages", "getSnapshot", "getTheme", "markRead", "onCommand", "onSnapshot", "openLink", "openTool", "reload", "setDetailOpen", "setPinned", "setSelection", "setTheme", "showSessionMenu"]`; the four Node globals are `"undefined"`. `getTheme` and `setTheme` expose only the System/Light/Dark preference. `setDetailOpen` synchronizes actual replacement-detail Back state at any width, independently of source availability. `setSelection` accepts a key/null plus optional exact `{secondPaneOpen:boolean}` metadata. Mark Read already acknowledges errors, so there is no separate `acknowledgeError` capability.
- **Validated requests (automated contract).** Run `npm exec -- vitest run src/main/ipc.test.ts src/preload/api.test.ts`. All tests pass. The synthetic main-process tests call every handler with foreign senders, same-URL child frames, and extra arguments and assert no reads or actions; they also exercise bad keys, tools, limits, pin values, invalid theme values, exact optional presentation metadata, and unsafe links. Theme reads accept no arguments; theme writes accept exactly one of `system`, `light` or `dark`. Controller contracts require native focus, active key and matching cursor for automatic reads; explicit Mark Read stays key-targeted. The preload tests assert the exact members, fixed channels, event stripping, and listener cleanup. This proves the request boundary with fakes; the bridge observation above proves the built renderer's actual capability surface. Never expose a raw IPC channel just to forge a sender from the page.
- **No navigation.** Try to leave the page. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs eval "(location.href = 'https://example.invalid/', 'tried')"`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs eval "location.href"`. The second result still ends in `/out/renderer/index.html`.
- **No new windows.** Try to open a window. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs eval "window.open('https://example.invalid/') === null"`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs main-eval "BrowserWindow.getAllWindows().length"`. The results are `true` and `1`.
- **No remote request.** Try to fetch from the network. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs eval "new Promise((done) => { document.addEventListener('securitypolicyviolation', (e) => done(e.violatedDirective), { once: true }); fetch('https://example.invalid/').catch(() => {}) })"`. The result is `"connect-src"`.
- **No remote image.** Try to load a remote image. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs eval "new Promise((done) => { document.addEventListener('securitypolicyviolation', (e) => done(e.violatedDirective), { once: true }); new Image().src = 'https://example.invalid/x.png' })"`. The result is `"img-src"`.
- **No eval.** Try `eval`. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs eval "(() => { try { eval('1'); return 'eval ran' } catch (e) { return e.name } })()"`. The result is `"EvalError"`.
- **No injected script.** Try to inject an inline script. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs eval "new Promise((done) => { document.addEventListener('securitypolicyviolation', (e) => done(e.violatedDirective), { once: true }); const s = document.createElement('script'); s.textContent = 'window.injected = true'; document.body.append(s) })"`, then `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs eval "window.injected === undefined"`. The results are `"script-src-elem"` and `true`.
- **No permissions.** Ask for notifications and check the camera. Run `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs eval "Notification.requestPermission()"` and `node .agents/skills/verify-agentpeek/scripts/agentpeek.mjs eval "navigator.permissions.query({ name: 'camera' }).then((p) => p.state)"`. Both results are `"denied"`, and no prompt appears.

## Gotchas

- Use only `.invalid` hosts: they never resolve, so nothing reaches a real server even if a guard fails.
- The `eval` command's own expression runs through the DevTools protocol, outside the page's CSP. What the expression starts (`eval()`, `new Function`, `fetch`, a new script element) meets the CSP like the page's own code, because the helper turns off DevTools' usual exception for `eval()`. A raw DevTools client without that setting reports `"eval ran"` and is not valid proof.
- Unpackaged builds let the page reload its own URL. The existing package blocks navigation; its inspector is disabled, so helper probes do not establish packaged behavior. See local-package.md.
- When the bridge gains members, update `bridge-only` to list them, and add a step showing that each IPC handler rejects bad arguments.
