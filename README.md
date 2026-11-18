# AgentPeek

Keep an eye on your local Codex and Claude Code sessions in one macOS window.

## Features

- See which sessions are running, waiting for you, have unread replies, or failed.
- Find sessions with **⌘K**, pin important ones, and group them by project or status.
- Read two sessions side by side and jump back to Codex or Claude.
- Choose System, Light, or Dark appearance, resize panes, and adjust text zoom.

**Shortcuts:** ⌘1–⌘4 switch views · ⌘K search · ⌘, settings.

## Run locally

Requires **macOS on Apple Silicon** and **Node.js 22.13+ (22.x) or 24+**.

```bash
git clone https://github.com/nstnn/agentpeek.git
cd agentpeek
npm ci
npm run dev
```

To build a local app bundle, run `npm run package`. The app is ad-hoc signed and not notarized.
See the [development guide](DEVELOPMENT.md) for builds, tests, synthetic data, and project layout.

## Privacy

By default, session data stays on your Mac. AgentPeek reads the tools' local files without
modifying them and does not store conversation text. No telemetry, background service, or
outbound network requests.

AgentPeek is a standalone windowed app built with Electron, TypeScript, and React.

## Remote View (beta)

Optionally check sessions from your own devices through Tailscale. Remote View is **off by
default**; session titles and recent messages have separate sharing controls. Recent-message
sharing has only been checked with synthetic data and is not yet accepted for real-session use.

See [Remote View](REMOTE_VIEW.md) for setup, privacy boundaries, and known limits.

## Project status

Early release. Final acceptance still has pending sleep/wake, external-app, and real-session checks.
Contributors: see [AGENTS.md](AGENTS.md) and the
[verification map](.agents/skills/verify-agentpeek/features/README.md).

## License

[MIT](LICENSE). Report vulnerabilities privately using [SECURITY.md](SECURITY.md).

Independent project; not affiliated with OpenAI or Anthropic. Codex and Claude Code are trademarks
of their respective owners.
