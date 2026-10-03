#!/usr/bin/env bash
# Installs the Linux build of Nanoleaf Desktop with a menu entry and icon.
#
#   scripts/install.sh [build dir]        # default: dist/nanoleaf-desktop
#   scripts/install.sh --uninstall
#
# Installs for the current user under ~/.local. For a system-wide install:
#   sudo PREFIX=/usr/local scripts/install.sh
#
# The app is copied, so rebuilding does not touch the installed copy: rebuild,
# then run this again to update. Settings (~/.config/Nanoleaf Desktop) and the
# Wine prefix (~/.local/share/nanoleaf-linux) are never removed.
set -euo pipefail

die() { echo "install: $*" >&2; exit 1; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PREFIX=${PREFIX:-$HOME/.local}
NAME=nanoleaf-desktop
APP_DIR=$PREFIX/lib/$NAME
BIN=$PREFIX/bin/$NAME
DESKTOP=$PREFIX/share/applications/$NAME.desktop
ICON=$PREFIX/share/icons/hicolor/512x512/apps/$NAME.png

refresh_caches() {
    command -v update-desktop-database >/dev/null && update-desktop-database -q "$PREFIX/share/applications" || true
    command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$PREFIX/share/icons/hicolor" || true
}

if [[ ${1:-} == --uninstall ]]; then
    rm -rf "$APP_DIR"
    rm -f "$BIN" "$DESKTOP" "$ICON"
    refresh_caches
    echo "Removed Nanoleaf Desktop from $PREFIX"
    exit 0
fi

SRC=$(realpath -m "${1:-$ROOT/dist/$NAME}")
[[ -x $SRC/$NAME ]] || die "no build in $SRC; run scripts/build.sh first"
[[ -f $SRC/$NAME.png ]] || die "$SRC has no icon; rebuild with the current scripts/build.sh"

echo "==> Installing to $APP_DIR"
mkdir -p "$PREFIX/lib" "$(dirname "$BIN")" "$(dirname "$DESKTOP")" "$(dirname "$ICON")"
rm -rf "$APP_DIR.new"
cp -a "$SRC" "$APP_DIR.new"
rm -rf "$APP_DIR"
mv "$APP_DIR.new" "$APP_DIR"

ln -sfn "$APP_DIR/$NAME" "$BIN"
install -m 644 "$SRC/$NAME.png" "$ICON"
# Exec is absolute: desktop launchers often lack ~/.local/bin in PATH.
sed "s|@EXEC@|$APP_DIR/$NAME|" "$ROOT/linux/$NAME.desktop" > "$DESKTOP"
chmod 644 "$DESKTOP"
refresh_caches

echo "==> Done. Launch \"Nanoleaf Desktop\" from the app menu, or run $BIN"
