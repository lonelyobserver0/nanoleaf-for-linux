#!/usr/bin/env bash
# Builds a Linux version of Nanoleaf Desktop from the official Windows installer.
#
#   scripts/build.sh "Nanoleaf Desktop Setup 3.0.0.exe" [output dir]
#
# Nothing from Nanoleaf is redistributed: the app is assembled locally from
# the installer the user downloaded.
set -euo pipefail

die() { echo "build: $*" >&2; exit 1; }

[[ $# -ge 1 ]] || die "usage: $0 <Nanoleaf Desktop Setup x.y.z.exe> [output dir]"
for tool in 7z node npm npx winegcc make; do
    command -v "$tool" >/dev/null || die "missing dependency: $tool"
done

ROOT=$(cd "$(dirname "$0")/.." && pwd)
INSTALLER=$(realpath "$1")
OUT=$(realpath -m "${2:-$ROOT/dist/nanoleaf-desktop}")
BUILD=$ROOT/build
WORK=$BUILD/work

rm -rf "$WORK"
mkdir -p "$WORK"

echo "==> Extracting installer"
7z x -y -o"$WORK/installer" "$INSTALLER" '$PLUGINSDIR/app-64.7z' >/dev/null
7z x -y -o"$WORK/win" "$WORK/installer/\$PLUGINSDIR/app-64.7z" >/dev/null
WIN_EXE=$(find "$WORK/win" -maxdepth 1 -name '*.exe' ! -name 'elevate.exe' | head -n1)
[[ -n $WIN_EXE ]] || die "no application executable found in the installer"

ELECTRON_VERSION=$(grep -aoE "Electron/[0-9]+\.[0-9]+\.[0-9]+" "$WIN_EXE" | head -n1 | cut -d/ -f2)
[[ -n $ELECTRON_VERSION ]] || die "cannot detect the Electron version"
echo "    Electron $ELECTRON_VERSION"

echo "==> Unpacking app.asar"
npx -y @electron/asar extract "$WORK/win/resources/app.asar" "$WORK/app"
APP_VERSION=$(node -p "require('$WORK/app/package.json').version")
echo "    Nanoleaf Desktop $APP_VERSION"

ELECTRON_DIR=$BUILD/electron-$ELECTRON_VERSION
if [[ ! -x $ELECTRON_DIR/dist/electron ]]; then
    echo "==> Fetching Electron $ELECTRON_VERSION for Linux"
    rm -rf "$ELECTRON_DIR"
    mkdir -p "$ELECTRON_DIR"
    (
        cd "$ELECTRON_DIR"
        npm init -y >/dev/null
        npm install --no-audit --no-fund --ignore-scripts "electron@$ELECTRON_VERSION" >/dev/null
        node node_modules/electron/install.js
        mv node_modules/electron/dist dist
        rm -rf node_modules package.json package-lock.json
    )
fi

echo "==> Fetching Linux native addons"
# Same packages the Windows build bundles, in their Linux flavour.
USB_VERSION=$(grep -oE 'Native binding package version mismatch, expected [0-9.]+' "$WORK/app/minified/main.js" | head -n1 | awk '{print $NF}')
HID_RANGE=$(node -p "require('$WORK/app/package.json').dependencies['node-hid']")
NATIVE=$WORK/native
mkdir -p "$NATIVE"
(
    cd "$NATIVE"
    npm pack --silent "@node-usb/usb-linux-x64-gnu@$USB_VERSION" "node-hid@$HID_RANGE" >/dev/null
    for t in *.tgz; do mkdir -p "${t%.tgz}" && tar -xzf "$t" -C "${t%.tgz}"; done
)
USB_NODE=$(find "$NATIVE" -name 'usb.linux-x64-gnu.node' | head -n1)
HID_NODE=$(find "$NATIVE" -path '*prebuilds/HID_hidraw-linux-x64/*.node' | head -n1)
[[ -n $USB_NODE && -n $HID_NODE ]] || die "Linux native addons not found in the npm packages"

echo "==> Building the Wine bridge"
make -s -C "$ROOT/helper" OUT="$BUILD/helper"

echo "==> Assembling $OUT"
rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
cp -a "$ELECTRON_DIR/dist" "$OUT"
mv "$OUT/electron" "$OUT/nanoleaf-desktop"
rm -f "$OUT/resources/default_app.asar"

RES=$OUT/resources
cp -a "$WORK/app" "$RES/app"
# The app looks for its native libraries in lib/<platform>-<arch>.
cp -a "$WORK/win/resources/app/lib/." "$RES/app/lib/"
mv "$RES/app/lib/win32-x64" "$RES/app/lib/linux-x64"
# Windows-only native addons are never loaded on Linux.
rm -f "$RES/app/minified/"*win32-x64*.node
rm -rf "$RES/app/minified/prebuilds/"*win32* "$RES/app/minified/prebuilds/usb"
cp "$USB_NODE" "$RES/app/minified/"
mkdir -p "$RES/app/minified/prebuilds/HID_hidraw-linux-x64"
cp "$HID_NODE" "$RES/app/minified/prebuilds/HID_hidraw-linux-x64/"

cp -a "$ROOT/shim" "$RES/app/linux-shim"
node "$ROOT/scripts/patch-bundle.cjs" "$RES/app/minified/main.js"
node -e '
const fs = require("fs"), f = process.argv[1]
const pkg = JSON.parse(fs.readFileSync(f, "utf8"))
pkg.main = "linux-shim/loader.mjs"
fs.writeFileSync(f, JSON.stringify(pkg, null, 2))
' "$RES/app/package.json"

# koffi only checks that this file exists; loader.mjs answers the require.
mkdir -p "$RES/koffi/linux_x64"
: > "$RES/koffi/linux_x64/koffi.node"

mkdir -p "$RES/nlbridge"
cp "$BUILD/helper/nlbridge.exe.so" "$RES/nlbridge/"

echo "==> Done: $OUT/nanoleaf-desktop"
