# Nanoleaf Desktop for Linux

Unofficial Linux port of [Nanoleaf Desktop](https://nanoleaf.me/en-US/integration/desktop-app/).
The build starts from the official Windows installer and redistributes nothing from Nanoleaf.

## How it works

Nanoleaf Desktop is an Electron app. Almost all of it (Angular UI, mDNS discovery,
OpenAPI over HTTP, CoAP, MQTT) is JavaScript and runs on Linux unchanged. The
Windows-specific parts are:

| Component | Solution |
|---|---|
| Windows Electron | Linux Electron, same version |
| `usb`, `node-hid` | Official Linux addons from npm |
| `koffi` (FFI) + 9 proprietary DLLs | **koffi shim + Wine bridge** (see below) |
| Updater (electron-updater) | Disabled (`--skip-update`): update by rebuilding |

### Wine bridge

Nanoleaf's DLLs are pure computation and depend only on the CRT (ECL/LTPDUv3
protocols, effect engines, colour calibration, Shazam signatures), so Wine
loads them without trouble. Electron itself does not run under Wine.

```
Electron (Linux)                               Wine
┌──────────────────────────┐   TCP localhost   ┌────────────────────────┐
│ original main.js         │   + token         │ nlbridge.exe.so        │
│   └ koffi  ──► shim/     │ ◄───────────────► │  LoadLibrary(libX.dll) │
│     koffi-shim.cjs       │                   │  ms_abi calls          │
│     (worker + Atomics)   │                   │  64 callback stubs     │
└──────────────────────────┘                   └────────────────────────┘
```

- `shim/loader.mjs` is the package's new `main`. It answers the `require` of
  `koffi.node` with the shim, then imports the original bundle unmodified.
- `shim/koffi-shim.cjs` implements the native koffi API the app uses
  (`load`, `func`, `.async`, `proto`, `struct`, `register`, `unregister`).
  It parses C signatures, copies buffers back after calls, handles re-entrant
  callbacks and keeps koffi's threading semantics.
- `shim/screen-mirror.cjs` reimplements `libScreenMirror.dll` (see below).
- `shim/audio.cjs` reimplements `libAudio.dll` for music sync (see below).
- `shim/stubs.cjs` holds Razer Chroma, which reports "nothing available".
- `scripts/patch-bundle.cjs` applies the few bundle edits that cannot be done
  from outside. Each patch must match exactly once, or the build stops.
- `helper/nlbridge.c` is a winelib program built with `winegcc`.

### Screen Mirror

On Linux the app uses its "legacy" backend (the DLL one), rewritten here in JS:

- **Capture** (`shim/screen-capture.cjs`): tries the ScreenCast portal first
  (PipeWire; works on GNOME, KDE, and Hyprland with `xdg-desktop-portal-hyprland`).
  Without it, falls back to `grim` (wlr-screencopy) at 8 fps, with no picker.
  `NANOLEAF_CAPTURE=portal|grim` forces a backend.
- **Analysis** (`shim/mirror-colors.cjs`), on a frame scaled down to 96 px wide:
  - 4D: each panel takes the part of the screen in front of it;
  - Tranquility: the dominant colour (k-means), smoothed, on every panel;
  - Flow: the dominant colour enters from the left and travels across the panels;
  - Chameleon: the screen's palette spread across the panels.
  The palette also feeds the Orchestrator.
- **Output**: the same `animData` JSON the DLL produced. The app sends the UDP
  frames to the devices.

### Music sync

`libAudio.dll` captures system audio or a single app (WASAPI). On Linux,
PipeWire does it with `pw-record --raw` (f32, 48 kHz, stereo, 20 ms latency):

- **All system audio**: the default output's monitor;
- one source per **app currently playing** (from `pw-dump`), identified by its
  binary name, which stays stable across restarts. `pw-record` starts
  unconnected, and every second **all** of the app's output streams are linked
  to its input with `pw-link`, where PipeWire mixes them. This is needed because
  Firefox, for example, opens several streams and creates new ones per tab or video.

The app only enabled capture on macOS ≥ 13 and Windows ≥ 22H2:
`patch-bundle.cjs` adds Linux to that check.

## Build

### Dependencies

Build: `wine` with `winegcc`, `7z`, `node`/`npm`, `make`, `curl` (only to download the
installer). Runtime: `wine`, PipeWire (`pw-record`, `pw-dump`, `pw-link`), plus `grim`
or a ScreenCast portal for Screen Mirror.

Arch Linux (all packages are in the official repos, so `paru`/`yay` work the same way):

```sh
sudo pacman -S --needed wine 7zip nodejs npm make curl pipewire pipewire-audio grim xdg-desktop-portal
# or: paru -S --needed …   /   yay -S --needed …
```

Debian 13 / Ubuntu 24.04 and later:

```sh
sudo apt install wine wine64 wine64-tools 7zip nodejs npm make curl pipewire-bin grim xdg-desktop-portal
```

On Debian/Ubuntu `winegcc` is installed as `winegcc-stable` (or `/usr/lib/wine/winegcc`);
the build finds it, or set `WINEGCC=/path/to/winegcc`.

For Screen Mirror, install the portal backend for your desktop
(`xdg-desktop-portal-gnome`, `-kde`, `-hyprland`, `-wlr`…). On wlroots compositors
(Hyprland, sway) `grim` alone is enough.

### Building

```sh
scripts/build.sh                     # downloads the latest official installer
dist/nanoleaf-desktop/nanoleaf-desktop
```

With no argument (or `latest`), the build fetches the installer from Nanoleaf's
own update server (the S3 bucket listed in the app's `app-update.yml`), checks
it against the sha512 published in `latest.yml`, and caches it in
`build/downloads/`. To use an installer you already have:

```sh
scripts/build.sh "Nanoleaf Desktop Setup 3.0.0.exe" [output dir]
```

### Installing

```sh
scripts/install.sh                   # installs for the current user under ~/.local
scripts/install.sh --uninstall
```

This copies the build to `~/.local/lib/nanoleaf-desktop`, links
`~/.local/bin/nanoleaf-desktop`, and adds a menu entry
(`linux/nanoleaf-desktop.desktop`) with the app's icon. Run it again after a rebuild
to update. `sudo PREFIX=/usr/local scripts/install.sh` installs system-wide.
Uninstalling keeps your settings and the Wine prefix.

The first launch creates a dedicated Wine prefix in `~/.local/share/nanoleaf-linux/wine`
(a few seconds). On later launches the bridge is ready in about 0.4 s.

Useful environment variables:

- `NANOLEAF_SHIM_DEBUG=1`: shim logging, and the app's log on stdout
- `NANOLEAF_WINE`, `NANOLEAF_WINEPREFIX`, `NANOLEAF_BRIDGE_HELPER`: overrides
- `NANOLEAF_CAPTURE=portal|grim`: Screen Mirror capture backend

## Tests

```sh
make -C helper
node test/smoke.cjs build/work/win/resources/app/lib/win32-x64
node test/screen-mirror.cjs                                  # colour analysis, synthetic screen
node test/audio.cjs                                          # PipeWire capture (play something)
build/electron-*/dist/electron test/capture-electron.cjs     # real screen capture (portal or grim)
```

## Status

- [x] Launch, UI, device discovery
- [x] All computation DLLs loaded under Wine
- [x] Pairing and control (Light Panels NL22)
- [ ] Dynamic effects (MotionPlayer) and LTPDUv3 devices on real hardware
- [x] Screen Mirror: portal/grim capture and all 4 modes, tested on Light Panels
- [x] Music sync: PipeWire capture (system or single app), tested on Light Panels
- [x] Menu entry and icon (`scripts/install.sh`)
- [ ] Packaging (AUR / AppImage)
