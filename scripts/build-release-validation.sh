#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACTS="$ROOT/artifacts/release-validation"
MACOS_DIR="$ARTIFACTS/macos"
WINDOWS_DIR="$ARTIFACTS/windows"
NODE_VERSION="${TERMPILOT_NODE_VERSION:-v22.16.0}"
NODE_BIN="${TERMPILOT_BUILD_NODE:-$(command -v node || true)}"
CARGO_BIN="${TERMPILOT_BUILD_CARGO:-$HOME/.cargo/bin/cargo}"
RESTORE_RUNTIME=0
TEMP_DIR=""
REMAP_RUSTFLAGS="--remap-path-prefix=$ROOT=/workspace"$'\x1f'"--remap-path-prefix=$HOME=/build-home"
if [[ -n "${CARGO_ENCODED_RUSTFLAGS:-}" ]]; then
  REMAP_RUSTFLAGS="${CARGO_ENCODED_RUSTFLAGS}"$'\x1f'"${REMAP_RUSTFLAGS}"
fi

log() {
  printf '\n==> %s\n' "$1"
}

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

sha256_file() {
  local output
  output="$(openssl dgst -sha256 -r "$1")"
  printf '%s' "${output%% *}"
}

prepare_runtime() {
  local platform="$1"
  local architecture="$2"
  TERMPILOT_NODE_VERSION="$NODE_VERSION" \
    TERMPILOT_RUNTIME_PLATFORM="$platform" \
    TERMPILOT_RUNTIME_ARCHITECTURE="$architecture" \
    TERMPILOT_FORCE_RUNTIME=1 \
    "$NODE_BIN" "$ROOT/scripts/prepare-bridge-runtime.mjs"
}

scan_payload() {
  TERMPILOT_SCAN_USER="$(id -un)" \
    TERMPILOT_SCAN_HOME="$HOME" \
    TERMPILOT_SCAN_HOSTNAME="$(hostname)" \
    TERMPILOT_SCAN_COMPUTER_NAME="$(scutil --get ComputerName 2>/dev/null || true)" \
    TERMPILOT_SCAN_PROJECT_PATH="$ROOT" \
    "$NODE_BIN" "$ROOT/scripts/scan-release-payload.mjs" "$@"
}

cleanup() {
  local status=$?
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
  if [[ "$RESTORE_RUNTIME" -eq 1 ]]; then
    log "Restoring macOS ARM64 Node runtime"
    if ! prepare_runtime darwin arm64; then
      printf 'warning: failed to restore the macOS Node runtime\n' >&2
      [[ "$status" -ne 0 ]] || status=1
    fi
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ "$(uname -s)" == "Darwin" ]] ||
  fail "this cross-platform release script must run on macOS"
[[ "$(uname -m)" == "arm64" ]] ||
  fail "macOS ARM64 packaging requires an Apple Silicon host"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] ||
  fail "Node.js was not found; set TERMPILOT_BUILD_NODE"
[[ -x "$CARGO_BIN" ]] ||
  fail "cargo was not found at $CARGO_BIN; set TERMPILOT_BUILD_CARGO"

for command in npm codesign hdiutil plutil zip unzip openssl file strings xattr makensis; do
  require_command "$command"
done
"$CARGO_BIN" xwin --version >/dev/null 2>&1 ||
  fail "cargo-xwin is required; install it before building"

cd "$ROOT"
SOURCE_VERSION="$("$NODE_BIN" -p \
  "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json', 'utf8')).version")"
VERSION="${1:-${TERMPILOT_VERSION:-$SOURCE_VERSION}}"
BUILD_NUMBER="${2:-${TERMPILOT_BUILD_NUMBER:-1}}"
[[ "$#" -le 2 ]] || fail "usage: $0 [version] [build-number]"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  fail "version must use major.minor.patch format: $VERSION"
[[ "$BUILD_NUMBER" =~ ^[0-9]+$ ]] ||
  fail "build number must be a non-negative integer: $BUILD_NUMBER"
IFS=. read -r VERSION_MAJOR VERSION_MINOR VERSION_PATCH <<<"$VERSION"
for component in "$VERSION_MAJOR" "$VERSION_MINOR" "$VERSION_PATCH" "$BUILD_NUMBER"; do
  ((10#$component <= 65535)) ||
    fail "Windows version components must not exceed 65535"
done
ARTIFACT_PREFIX="TermPilot-${VERSION}"
MACOS_ARM64_APP_NAME="${ARTIFACT_PREFIX}-macos-arm64"
MACOS_AMD64_APP_NAME="${ARTIFACT_PREFIX}-macos-amd64"
WINDOWS_APP_NAME="${ARTIFACT_PREFIX}-windows-x64"
MACOS_ARM64_APP="$ROOT/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/TermPilot.app"
MACOS_AMD64_APP="$ROOT/src-tauri/target/x86_64-apple-darwin/release/bundle/macos/TermPilot.app"
WINDOWS_EXE="$ROOT/src-tauri/target/x86_64-pc-windows-msvc/release/termpilot.exe"
MACOS_ARM64_DIR="$MACOS_DIR/arm64"
MACOS_AMD64_DIR="$MACOS_DIR/amd64"
PORTABLE_DIR="$WINDOWS_DIR/${WINDOWS_APP_NAME}-portable"
MACOS_ARM64_DMG="$ARTIFACTS/${MACOS_ARM64_APP_NAME}.dmg"
MACOS_ARM64_ZIP="$ARTIFACTS/${MACOS_ARM64_APP_NAME}.zip"
MACOS_AMD64_DMG="$ARTIFACTS/${MACOS_AMD64_APP_NAME}.dmg"
MACOS_AMD64_ZIP="$ARTIFACTS/${MACOS_AMD64_APP_NAME}.zip"
WINDOWS_ZIP="$ARTIFACTS/${WINDOWS_APP_NAME}-portable.zip"
WINDOWS_SETUP="$ARTIFACTS/${WINDOWS_APP_NAME}-setup.exe"
CHECKSUMS="$ARTIFACTS/SHA256SUMS.txt"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/termpilot-release.XXXXXX")"
BUILD_CONFIG="$TEMP_DIR/release-version.json"
printf '{"version":"%s","bundle":{"macOS":{"bundleVersion":"%s"}}}\n' \
  "$VERSION" "$BUILD_NUMBER" >"$BUILD_CONFIG"
TAURI_CONFIG_JSON="$(cat "$BUILD_CONFIG")"

mkdir -p "$MACOS_DIR" "$WINDOWS_DIR"

build_macos_release() {
  local target="$1"
  local runtime_arch="$2"
  local artifact_arch="$3"
  local file_arch="$4"
  local app="$5"
  local package_dir="$6"
  local archive="$7"
  local disk_image="$8"

  log "Building TermPilot $VERSION ($BUILD_NUMBER) for macOS $artifact_arch"
  prepare_runtime darwin "$runtime_arch"
  PATH="$(dirname "$NODE_BIN"):$HOME/.cargo/bin:$PATH" \
    CARGO_ENCODED_RUSTFLAGS="$REMAP_RUSTFLAGS" \
    npm run tauri -- build \
      --target "$target" \
      --bundles app \
      --config "$BUILD_CONFIG"
  [[ -d "$app" ]] || fail "macOS $artifact_arch app bundle was not generated"
  xattr -cr "$app"
  codesign --force --deep --sign - "$app"
  codesign --verify --deep --strict --verbose=2 "$app"
  file "$app/Contents/MacOS/TermPilot" | grep -q "$file_arch" ||
    fail "macOS executable is not $artifact_arch"
  file "$app/Contents/Resources/node/bin/node" | grep -q "$file_arch" ||
    fail "macOS Node runtime is not $artifact_arch"
  scan_payload "$app"

  log "Packaging macOS $artifact_arch ZIP and DMG"
  rm -rf "$package_dir"
  mkdir -p "$package_dir"
  cp -R "$app" "$package_dir/TermPilot.app"
  rm -f "$archive" "$disk_image"
  (
    cd "$package_dir"
    COPYFILE_DISABLE=1 zip -qry -X "$archive" TermPilot.app
  )
  hdiutil create \
    -volname TermPilot \
    -srcfolder "$package_dir" \
    -ov \
    -format UDZO \
    "$disk_image"
}

verify_macos_release() {
  local artifact_arch="$1"
  local file_arch="$2"
  local package_dir="$3"
  local archive="$4"
  local disk_image="$5"
  local app="$package_dir/TermPilot.app"

  codesign --verify --deep --strict --verbose=2 "$app"
  [[ "$(plutil -extract CFBundleShortVersionString raw \
    "$app/Contents/Info.plist")" == "$VERSION" ]] ||
    fail "macOS $artifact_arch app version does not match $VERSION"
  [[ "$(plutil -extract CFBundleVersion raw \
    "$app/Contents/Info.plist")" == "$BUILD_NUMBER" ]] ||
    fail "macOS $artifact_arch app build number does not match $BUILD_NUMBER"
  [[ "$(plutil -extract CFBundleIconFile raw \
    "$app/Contents/Info.plist")" == "icon.icns" ]] ||
    fail "macOS $artifact_arch app does not declare icon.icns"
  [[ -f "$app/Contents/Resources/icon.icns" ]] ||
    fail "macOS $artifact_arch app is missing icon.icns"
  hdiutil verify "$disk_image"
  unzip -t "$archive" >/dev/null
  file "$app/Contents/MacOS/TermPilot" | grep -q "$file_arch" ||
    fail "macOS executable is not $artifact_arch"
  file "$app/Contents/Resources/node/bin/node" | grep -q "$file_arch" ||
    fail "macOS Node runtime is not $artifact_arch"
}

build_macos_release \
  aarch64-apple-darwin arm64 arm64 arm64 \
  "$MACOS_ARM64_APP" "$MACOS_ARM64_DIR" \
  "$MACOS_ARM64_ZIP" "$MACOS_ARM64_DMG"

RESTORE_RUNTIME=1
build_macos_release \
  x86_64-apple-darwin x64 amd64 x86_64 \
  "$MACOS_AMD64_APP" "$MACOS_AMD64_DIR" \
  "$MACOS_AMD64_ZIP" "$MACOS_AMD64_DMG"

log "Building Windows x64 application"
prepare_runtime win32 x64
(
  cd "$ROOT/src-tauri"
  TAURI_CONFIG="$TAURI_CONFIG_JSON" \
    CARGO_ENCODED_RUSTFLAGS="$REMAP_RUSTFLAGS" \
    "$CARGO_BIN" xwin build \
    --release \
    --target x86_64-pc-windows-msvc \
    --features custom-protocol
)
[[ -f "$WINDOWS_EXE" ]] || fail "Windows executable was not generated"

log "Packaging Windows x64 Portable ZIP"
rm -rf "$PORTABLE_DIR"
mkdir -p "$PORTABLE_DIR/node_modules" "$PORTABLE_DIR/licenses"
cp "$WINDOWS_EXE" "$PORTABLE_DIR/TermPilot.exe"
cp -R "$ROOT/bridge" "$PORTABLE_DIR/bridge"
cp -R "$ROOT/runtime/node" "$PORTABLE_DIR/node"
cp -R "$ROOT/runtime/node_modules/." "$PORTABLE_DIR/node_modules/"
cp "$ROOT/public/AutocompleteSpecs.bundledata" "$PORTABLE_DIR/"
cp "$ROOT/public/AutocompleteSpecs.LICENSE" "$PORTABLE_DIR/licenses/"
cp "$ROOT/runtime/licenses/Node-${NODE_VERSION}.txt" "$PORTABLE_DIR/licenses/"
xattr -cr "$PORTABLE_DIR"
scan_payload "$PORTABLE_DIR"
rm -f "$WINDOWS_ZIP"
(
  cd "$WINDOWS_DIR"
  COPYFILE_DISABLE=1 zip -qry -X "$WINDOWS_ZIP" "$(basename "$PORTABLE_DIR")"
)

log "Packaging Windows x64 NSIS installer"
rm -f "$WINDOWS_SETUP"
makensis \
  -DSOURCE_DIR="$PORTABLE_DIR" \
  -DOUTPUT_FILE="$WINDOWS_SETUP" \
  -DAPP_ICON="$ROOT/src-tauri/icons/icon.ico" \
  -DAPP_VERSION="$VERSION" \
  -DAPP_BUILD_NUMBER="$BUILD_NUMBER" \
  "$ROOT/scripts/windows-installer.nsi"

log "Restoring macOS ARM64 Node runtime"
prepare_runtime darwin arm64
RESTORE_RUNTIME=0

log "Verifying release packages"
verify_macos_release \
  arm64 arm64 "$MACOS_ARM64_DIR" \
  "$MACOS_ARM64_ZIP" "$MACOS_ARM64_DMG"
verify_macos_release \
  amd64 x86_64 "$MACOS_AMD64_DIR" \
  "$MACOS_AMD64_ZIP" "$MACOS_AMD64_DMG"
unzip -t "$WINDOWS_ZIP" >/dev/null
mkdir -p \
  "$TEMP_DIR/macos-arm64-zip" \
  "$TEMP_DIR/macos-amd64-zip" \
  "$TEMP_DIR/windows-zip"
unzip -q "$MACOS_ARM64_ZIP" -d "$TEMP_DIR/macos-arm64-zip"
unzip -q "$MACOS_AMD64_ZIP" -d "$TEMP_DIR/macos-amd64-zip"
unzip -q "$WINDOWS_ZIP" -d "$TEMP_DIR/windows-zip"
scan_payload \
  "$TEMP_DIR/macos-arm64-zip" \
  "$TEMP_DIR/macos-amd64-zip" \
  "$TEMP_DIR/windows-zip"
for archive in "$MACOS_ARM64_ZIP" "$MACOS_AMD64_ZIP"; do
  if unzip -Z1 "$archive" | grep -Eq '(^|/)\._|^__MACOSX/'; then
    fail "$(basename "$archive") contains AppleDouble metadata"
  fi
done
if unzip -Z1 "$WINDOWS_ZIP" | grep -Eq '(^|/)\._|^__MACOSX/'; then
  fail "Windows ZIP contains AppleDouble metadata"
fi
file "$PORTABLE_DIR/TermPilot.exe" |
  grep -q "PE32+ executable (GUI) x86-64" ||
  fail "Windows executable is not x86-64"
file "$PORTABLE_DIR/node/node.exe" |
  grep -q "PE32+ executable (console) x86-64" ||
  fail "Windows Node runtime is not x86-64"
file "$WINDOWS_SETUP" |
  grep -q "Nullsoft Installer" ||
  fail "Windows installer is not a valid NSIS executable"
strings "$PORTABLE_DIR/TermPilot.exe" >"$TEMP_DIR/windows-exe-strings.txt"
grep -q "/assets/index-" "$TEMP_DIR/windows-exe-strings.txt" ||
  fail "Windows executable does not contain embedded frontend assets"
[[ -f "$PORTABLE_DIR/bridge/sftp-bridge/termpilot-sftp-bridge.cjs" ]] ||
  fail "Windows Portable package is missing the SFTP bridge"
[[ -f "$PORTABLE_DIR/AutocompleteSpecs.bundledata" ]] ||
  fail "Windows Portable package is missing autocomplete data"

log "Generating SHA-256 checksums"
: >"$CHECKSUMS"
for artifact in \
  "$MACOS_ARM64_ZIP" \
  "$MACOS_AMD64_ZIP" \
  "$WINDOWS_ZIP"
do
  printf '%s  %s\n' \
    "$(sha256_file "$artifact")" \
    "$(basename "$artifact")" \
    >>"$CHECKSUMS"
done
while read -r expected filename; do
  actual="$(sha256_file "$ARTIFACTS/$filename")"
  [[ "$actual" == "$expected" ]] ||
    fail "SHA-256 verification failed for $filename"
  printf '%s: OK\n' "$filename"
done <"$CHECKSUMS"

log "Removing quarantine attributes"
for artifact in \
  "$MACOS_ARM64_DIR/TermPilot.app" \
  "$MACOS_AMD64_DIR/TermPilot.app" \
  "$MACOS_ARM64_DMG" \
  "$MACOS_ARM64_ZIP" \
  "$MACOS_AMD64_DMG" \
  "$MACOS_AMD64_ZIP" \
  "$PORTABLE_DIR" \
  "$WINDOWS_SETUP" \
  "$WINDOWS_ZIP" \
  "$CHECKSUMS"
do
  xattr -rc "$artifact"
done

log "Release artifacts"
ls -lh \
  "$MACOS_ARM64_DMG" \
  "$MACOS_ARM64_ZIP" \
  "$MACOS_AMD64_DMG" \
  "$MACOS_AMD64_ZIP" \
  "$WINDOWS_SETUP" \
  "$WINDOWS_ZIP" \
  "$CHECKSUMS"
printf 'Version: %s (%s)\n' "$VERSION" "$BUILD_NUMBER"
