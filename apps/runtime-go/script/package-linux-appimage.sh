#!/usr/bin/env bash
set -euo pipefail

: "${VERSION:?VERSION is required}"
: "${OUTPUT_DIR:?OUTPUT_DIR is required}"
: "${LINUXDEPLOY:?LINUXDEPLOY is required}"
: "${APPIMAGETOOL:?APPIMAGETOOL is required}"

runtime_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
desktop_root="$runtime_root/cmd/awsm"
output_dir=$(cd "$OUTPUT_DIR" && pwd)
app_dir="$output_dir/AppDir"
binary="$desktop_root/build/bin/awsm-desktop"
icon="$desktop_root/build/appicon.png"
desktop_file="$app_dir/usr/share/applications/awsm.desktop"
appimage="$output_dir/awsm-desktop-linux-x86_64-v${VERSION}.AppImage"

test -x "$binary"
test -f "$icon"
rm -rf "$app_dir"
mkdir -p \
  "$app_dir/usr/bin" \
  "$app_dir/usr/share/applications" \
  "$app_dir/usr/share/icons/hicolor/512x512/apps"

install -Dm755 "$binary" "$app_dir/usr/bin/awsm-desktop"
install -Dm644 "$icon" "$app_dir/usr/share/icons/hicolor/512x512/apps/awsm.png"

cat > "$app_dir/AppRun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$HERE/usr/bin/awsm-desktop" "$@"
EOF
chmod 755 "$app_dir/AppRun"

cat > "$desktop_file" <<'EOF'
[Desktop Entry]
Type=Application
Name=AWSM
Comment=Archive What Should Matter
Exec=awsm-desktop %U
Icon=awsm
Terminal=false
Categories=Utility;Office;
StartupWMClass=AWSM
EOF

APPIMAGE_EXTRACT_AND_RUN=1 "$LINUXDEPLOY" \
  --appdir "$app_dir" \
  --executable "$app_dir/usr/bin/awsm-desktop" \
  --desktop-file "$desktop_file" \
  --icon-file "$app_dir/usr/share/icons/hicolor/512x512/apps/awsm.png"

rm -f "$appimage"
APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGETOOL" "$app_dir" "$appimage"
chmod 755 "$appimage"
sha256sum "$appimage" > "$appimage.sha256"
sha256sum --check "$appimage.sha256"
printf 'Created %s\n' "$appimage"
