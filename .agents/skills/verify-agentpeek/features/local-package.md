# Local macOS package

The local Apple Silicon build is `dist/mac-arm64/AgentPeek.app`. Finder shows the AgentPeek icon and name; About shows the package version. It opens one window, enforces the default and minimum sizes, and quits when that window closes. The bundle uses ad-hoc signing, hardened runtime and five security fuses.

## Sub-features

- `package-identity` names the arm64 bundle AgentPeek, with ID `com.nstnn.agentpeek`, an icon, and the version from `package.json`.
- `package-signature` passes strict deep signature verification and reports an ad-hoc signature with hardened runtime.
- `package-fuses` disables RunAsNode, NODE_OPTIONS and the main-process inspector, and enables ASAR-only loading and embedded ASAR integrity validation.
- `package-launch` opens the packaged window through LaunchServices with synthetic overrides, and Finder can reopen that running instance.
- `package-about` shows AgentPeek and its version in the native About panel.
- `package-window` first opens maximized within the work area, restores size/position and maximized/Full Screen mode after normal close/quit, clamps a native resize to 760 × 480, and shows one window when opened again.
- `package-close` exits all processes from this bundle when its red close button is clicked.

## How to get to it (user POV)

- Run `npm run package` to create the local app without launching it.
- Open AgentPeek.app from Finder. Agent-run launches must use the isolated setup below first.
- Choose AgentPeek > About AgentPeek or Settings…, use View's Zoom controls, drag a window corner, open it again, or click its red close button.

## Driving it with agentpeek.mjs

Preconditions:

- The user approved launches and native Computer Use for this task. Never use real sessions without separate consent.
- Run `npm run package`, then inspect the exact bundle with `codesign --verify --deep --strict --verbose=2 dist/mac-arm64/AgentPeek.app`, `codesign -dv --verbose=4 dist/mac-arm64/AgentPeek.app`, and `npx --no-install @electron/fuses read --app dist/mac-arm64/AgentPeek.app`. Record all five required fuse states, architecture, bundle version and signature.
- This package disables the inspector that `agentpeek.mjs` needs. Keep helper/Playwright checks on `out/`; use native Computer Use for the packaged checks below.

- **Isolated launch.** Run `node scripts/fixture/index.mjs create`. Use the returned absolute `home` and `userData` in `open -n -a "$PWD/dist/mac-arm64/AgentPeek.app" --env AGENTPEEK_HOME=<home> --env AGENTPEEK_USER_DATA=<userData> --args --user-data-dir=<userData>`. Confirm that process is running before binding the native tool to the exact app path. The window must show the matching Fixture data banner, 100 total sessions and seven running sessions. Save synthetic-only accessibility and window captures.
- **About.** Open the AgentPeek menu, refresh a full accessibility tree, then choose About AgentPeek from that tree. Capture the native panel showing AgentPeek and the package version. Close only the About panel with Command-W.
- **Menus.** Open AgentPeek and save its native menu tree: About AgentPeek, Settings… and Quit AgentPeek are present. Open View and save its native menu tree. It must have the three views, Reload Sessions, Zoom In, Zoom Out, Actual Size and a disabled current Zoom percentage, with no Toggle Developer Tools. Dismiss each menu through its exposed Cancel action. Follow settings.md and zoom.md for their interaction paths; helper evidence alone does not prove packaged menu drawing or native shortcut delivery.
- **Window sizes and restoration.** A fresh synthetic profile opens maximized within the current work area, without entering macOS Full Screen. Save the initial window capture and actual dimensions. Leave maximization through Window > Zoom, drag its bottom-right corner below the minimum, and save the resulting layout: the minimum is 760 × 480 points (1520 × 960 pixels at 2×). The narrow layout hides the detail placeholder and retains the source/sidebar and list controls. Close, then restart this same bundle with the same synthetic home/profile before cleanup; the chosen normal size/position returns. Repeat after maximizing and after the native green Full Screen button, waiting for its transition before quitting. Save reopened native captures for each mode. Confirm capture scale before interpreting pixel dimensions.
- **Single instance.** Record the exact main PID. Start the same bundle executable against the same two overrides and profile; the second process must exit with code 0 and the first PID must survive. Reopen the app from a new Finder window while that fixture process is running; confirm the same fixture banner and only one main PID/window.
- **Close and clean up.** Click the main window's red close button, then inspect process exit outside the native app binding. No process with this bundle's exact path may remain. Close only the Finder window this run opened and run `node scripts/fixture/index.mjs clean <home>`. Retain evidence; keep the requested local build in ignored `dist/`.

## Gotchas

- On macOS, `cua.getApp` and later observations can launch a stopped app automatically, without fixture overrides. Never bind before the explicit isolated launch, and never observe through that app binding after it has quit. Use exact-path process checks for shutdown instead.
- Native menu trees can renumber items between captures. Refresh with `disableDiffing: true`, derive the next action from that full tree, and avoid hidden extra captures between reading an index and clicking it. An emitted observation may return no value; use `emit: false` when saving it and display the same returned tree for the next decision.
- Inspect saved native captures with `file` before naming them PNG or interpreting their dimensions. The native tool can return JPEG bytes; use the matching extension and record the actual pixel size. A capture can also be absent while a menu is open; retain the menu tree and report the missing image.
- A fixture launch checks bundle usability and visible prompts only. TCC access to real tool folders remains a separate consented real-data check in TASK-016. Do not infer that access from synthetic data.
- Do not flip fuses off, add inspector access, change macOS settings, or install into /Applications to make verification easier.
