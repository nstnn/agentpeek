# Remote View (beta)

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
