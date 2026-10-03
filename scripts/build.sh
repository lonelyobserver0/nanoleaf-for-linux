#!/usr/bin/env bash
# Builds a Linux version of Nanoleaf Desktop from the official Windows installer.
#
#   scripts/build.sh                                       # download the latest installer
#   scripts/build.sh latest [output dir]
#   scripts/build.sh "Nanoleaf Desktop Setup 3.0.0.exe" [output dir]
#
# Nothing from Nanoleaf is redistributed: the app is assembled locally from
# the official installer, downloaded from Nanoleaf's update server (and checked
# against the sha512 it publishes) or supplied by the user.
set -euo pipefail

die() { echo "build: $*" >&2; exit 1; }

SOURCE=${1:-latest}
for tool in 7z node npm npx make; do
    command -v "$tool" >/dev/null || die "missing dependency: $tool"
done
# Debian/Ubuntu ship winegcc as winegcc-stable or under /usr/lib/wine.
WINEGCC=${WINEGCC:-$(command -v winegcc || command -v winegcc-stable || command -v /usr/lib/wine/winegcc || true)}
[[ -n $WINEGCC ]] || die "missing dependency: winegcc (package wine on Arch, wine64-tools on Debian/Ubuntu)"

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(realpath -m "${2:-$ROOT/dist/nanoleaf-desktop}")
BUILD=$ROOT/build
WORK=$BUILD/work

# Where Nanoleaf Desktop's own updater looks for releases (app-update.yml).
UPDATE_URL=https://desktop-app-prod-3.s3.us-west-2.amazonaws.com

# Prints the base64 sha512 of a file, the format latest.yml uses.
sha512_b64() {
    node -e 'process.stdout.write(require("crypto").createHash("sha512").update(require("fs").readFileSync(process.argv[1])).digest("base64"))' "$1"
}

download_installer() {
    command -v curl >/dev/null || die "missing dependency: curl"
    local meta name hash file
    meta=$(curl -fsSL "$UPDATE_URL/latest.yml") || die "cannot fetch $UPDATE_URL/latest.yml"
    # Top-level keys of latest.yml: "path: <file name>" and "sha512: <base64>".
    name=$(sed -n 's/^path: *//p' <<<"$meta" | tr -d "'\"")
    hash=$(sed -n 's/^sha512: *//p' <<<"$meta" | tr -d "'\"")
    [[ -n $name && -n $hash ]] || die "unexpected latest.yml format"
    [[ $name == *.exe && $name != */* ]] || die "unexpected installer name in latest.yml: $name"

    mkdir -p "$BUILD/downloads"
    file=$BUILD/downloads/$name
    if [[ -f $file && $(sha512_b64 "$file") == "$hash" ]]; then
        echo "    using cached $name" >&2
    else
        echo "==> Downloading $name" >&2
        curl -fL --progress-bar -o "$file.part" "$UPDATE_URL/$(node -p 'encodeURIComponent(process.argv[1])' "$name")" \
            || die "download failed"
        [[ $(sha512_b64 "$file.part") == "$hash" ]] || { rm -f "$file.part"; die "sha512 mismatch for $name"; }
        mv "$file.part" "$file"
    fi
    printf '%s\n' "$file"
}

if [[ $SOURCE == latest ]]; then
    INSTALLER=$(download_installer)
else
    [[ -f $SOURCE ]] || die "installer not found: $SOURCE"
    INSTALLER=$(realpath "$SOURCE")
fi

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
# asar 4.x needs Node >= 22.12; 3.x reads the same format on older distro Node.
npx -y @electron/asar@3.4.1 extract "$WORK/win/resources/app.asar" "$WORK/app"
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
make -s -C "$ROOT/helper" OUT="$BUILD/helper" WINEGCC="$WINEGCC"

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

# Menu entry and icon (the app's own 512 px macOS icon suits Linux themes);
# scripts/install.sh puts them in place.
cp "$WORK/app/web/assets/images/icons/icon-macos.png" "$OUT/nanoleaf-desktop.png"
sed "s|@EXEC@|$OUT/nanoleaf-desktop|" "$ROOT/linux/nanoleaf-desktop.desktop" > "$OUT/nanoleaf-desktop.desktop"

echo "==> Done: $OUT/nanoleaf-desktop"
