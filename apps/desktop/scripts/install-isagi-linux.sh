#!/bin/sh

set -eu

APPIMAGE_NAME='Isagi-linux-x86_64.AppImage'
DESKTOP_NAME='studio.yourtechbud.isagi.desktop'
MANAGED_MARKER='X-Isagi-Managed=true'
ICON_SIZES='16 24 32 48 64 96 128 256 512'

usage() {
  printf '%s\n' "Usage: install-isagi-linux.sh [APPIMAGE]" "" \
    "Install Isagi for the current user and register it in the application menu." \
    "With no APPIMAGE argument, the installer uses $APPIMAGE_NAME beside this script."
}

fail() {
  printf 'install-isagi-linux.sh: %s\n' "$1" >&2
  exit 1
}

reject_controls() {
  value_without_controls=$(printf '%s' "$2" | LC_ALL=C tr -d '\001-\037\177')
  [ "$value_without_controls" = "$2" ] || fail "$1 cannot contain ASCII control characters."
}

case ${1-} in
  --help|-h)
    [ "$#" -eq 1 ] || fail '--help does not accept additional arguments.'
    usage
    exit 0
    ;;
  -*) fail "unknown option: $1" ;;
esac
[ "$#" -le 1 ] || fail 'expected zero or one APPIMAGE argument.'

[ "$(id -u)" -ne 0 ] || fail 'refusing to install as UID 0; run as your normal user.'
[ "$(uname -s)" = 'Linux' ] || fail 'the Isagi AppImage installer requires Linux.'
case $(uname -m) in
  x86_64|amd64) ;;
  *) fail 'the Isagi AppImage installer requires an x86-64 host.' ;;
esac

if [ "$#" -eq 1 ]; then
  source_appimage=$1
else
  script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || fail 'could not resolve the installer directory.'
  source_appimage=$script_directory/$APPIMAGE_NAME
fi
reject_controls 'source AppImage path' "$source_appimage"
case $source_appimage in
  /*) ;;
  *) source_appimage=$(CDPATH= cd -- "$(dirname -- "$source_appimage")" && pwd -P)/$(basename -- "$source_appimage") ;;
esac

if [ -n "${XDG_DATA_HOME-}" ]; then
  data_home=$XDG_DATA_HOME
else
  [ -n "${HOME-}" ] || fail 'HOME must be set when XDG_DATA_HOME is unset or empty.'
  case $HOME in /*) ;; *) fail 'HOME must be an absolute path.' ;; esac
  data_home=$HOME/.local/share
fi
case $data_home in /*) ;; *) fail 'XDG_DATA_HOME must be an absolute path.' ;; esac
reject_controls 'XDG_DATA_HOME' "$data_home"
case $data_home in *=*) fail 'XDG_DATA_HOME cannot contain an equals sign.' ;; esac
newline='
'

[ ! -L "$source_appimage" ] || fail "source AppImage is a symlink: $source_appimage"
[ -f "$source_appimage" ] || fail "source AppImage is not a regular file: $source_appimage"

elf_magic=$(od -An -v -t x1 -N 4 "$source_appimage" | tr -d ' \n')
[ "$elf_magic" = '7f454c46' ] || fail 'source AppImage does not have ELF magic.'
elf_machine=$(dd if="$source_appimage" bs=1 skip=18 count=2 2>/dev/null | od -An -v -t x1 | tr -d ' \n')
[ "$elf_machine" = '3e00' ] || fail 'source AppImage is not an x86-64 ELF executable.'

owner_of() {
  stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"
}

assert_owned_directory() {
  [ ! -L "$1" ] || fail "managed directory is a symlink: $1"
  [ -d "$1" ] || fail "managed path is not a directory: $1"
  [ "$(owner_of "$1")" = "$(id -u)" ] || fail "managed directory is not owned by the invoking user: $1"
}

ensure_directory() {
  if [ -e "$1" ] || [ -L "$1" ]; then
    assert_owned_directory "$1"
  else
    ensure_parent=$(dirname -- "$1")
    [ -d "$ensure_parent" ] || fail "managed directory parent does not exist: $ensure_parent"
    assert_owned_directory "$ensure_parent"
    mkdir "$1"
  fi
}

assert_replaceable_file() {
  if [ -e "$1" ] || [ -L "$1" ]; then
    [ ! -L "$1" ] || fail "managed file is a symlink: $1"
    [ -f "$1" ] || fail "managed path is not a regular file: $1"
    [ "$(owner_of "$1")" = "$(id -u)" ] || fail "managed file is not owned by the invoking user: $1"
  fi
}

extract_parent=$(mktemp -d "${TMPDIR:-/tmp}/isagi-appimage-extract.XXXXXX") || fail 'could not create an extraction directory.'
validation_appimage=$extract_parent/$APPIMAGE_NAME
staged_appimage=''
staged_desktop=''
staged_icons=''
cleanup() {
  [ -z "$staged_appimage" ] || rm -f "$staged_appimage"
  [ -z "$staged_desktop" ] || rm -f "$staged_desktop"
  if [ -n "$staged_icons" ]; then
    old_ifs=$IFS
    IFS=$newline
    for staged_icon in $staged_icons; do rm -f "$staged_icon"; done
    IFS=$old_ifs
  fi
  rm -rf "$extract_parent"
}
trap cleanup EXIT HUP INT TERM

cp "$source_appimage" "$validation_appimage"
chmod 0755 "$validation_appimage"
(CDPATH= cd -- "$extract_parent" && "$validation_appimage" --appimage-extract >/dev/null) || fail 'AppImage extraction failed; use an official Isagi Linux release asset.'
extracted_root=$extract_parent/squashfs-root
[ -d "$extracted_root" ] || fail 'AppImage extraction did not produce squashfs-root.'

embedded_desktop=$extracted_root/$DESKTOP_NAME
[ -f "$embedded_desktop" ] && [ ! -L "$embedded_desktop" ] || fail 'AppImage is missing the expected Isagi desktop entry.'
grep -Fqx 'Name=Isagi' "$embedded_desktop" || fail 'AppImage desktop entry does not identify Isagi.'
grep -Fqx 'Icon=isagi' "$embedded_desktop" || fail 'AppImage desktop entry does not use the Isagi icon name.'
for size in $ICON_SIZES; do
  embedded_icon=$extracted_root/usr/share/icons/hicolor/${size}x${size}/apps/isagi.png
  [ -f "$embedded_icon" ] && [ ! -L "$embedded_icon" ] || fail "AppImage is missing the ${size}x${size} Isagi icon."
done

if [ ! -e "$data_home" ] && [ ! -L "$data_home" ]; then
  mkdir -p "$data_home"
fi
assert_owned_directory "$data_home"
app_directory=$data_home/isagi
applications_directory=$data_home/applications
icons_root=$data_home/icons/hicolor
ensure_directory "$app_directory"
ensure_directory "$applications_directory"
ensure_directory "$data_home/icons"
ensure_directory "$icons_root"

app_destination=$app_directory/Isagi.AppImage
desktop_destination=$applications_directory/$DESKTOP_NAME
assert_replaceable_file "$app_destination"
assert_replaceable_file "$desktop_destination"
if [ -f "$desktop_destination" ] && ! grep -Fqx "$MANAGED_MARKER" "$desktop_destination"; then
  fail "refusing to replace an application entry not managed by Isagi: $desktop_destination"
fi

staged_appimage=$(mktemp "$app_directory/.Isagi.AppImage.XXXXXX") || fail 'could not stage the AppImage.'
cp "$validation_appimage" "$staged_appimage"
chmod 0755 "$staged_appimage"

for size in $ICON_SIZES; do
  embedded_icon=$extracted_root/usr/share/icons/hicolor/${size}x${size}/apps/isagi.png
  icon_size_directory=$icons_root/${size}x${size}
  icon_directory=$icon_size_directory/apps
  ensure_directory "$icon_size_directory"
  ensure_directory "$icon_directory"
  icon_destination=$icon_directory/isagi.png
  assert_replaceable_file "$icon_destination"
  staged_icon=$(mktemp "$icon_directory/.isagi.png.XXXXXX") || fail "could not stage the ${size}x${size} icon."
  cp "$embedded_icon" "$staged_icon"
  chmod 0644 "$staged_icon"
  staged_icons=${staged_icons:+$staged_icons$newline}$staged_icon
done

exec_quoted=$(printf '%s' "$app_destination" | sed 's/\\/\\\\/g; s/"/\\"/g; s/`/\\`/g; s/\$/\\$/g; s/%/%%/g')
exec_value=$(printf '%s' "$exec_quoted" | sed 's/\\/\\\\/g')
staged_desktop=$(mktemp "$applications_directory/.$DESKTOP_NAME.XXXXXX") || fail 'could not stage the desktop entry.'
{
  printf '%s\n' '[Desktop Entry]' 'Version=1.0' 'Type=Application' 'Name=Isagi'
  printf 'Exec="%s"\n' "$exec_value"
  printf '%s\n' 'Icon=isagi' 'Categories=Development;' 'Terminal=false' 'StartupWMClass=studio.yourtechbud.isagi' "$MANAGED_MARKER"
} >"$staged_desktop"
chmod 0644 "$staged_desktop"

mv -f "$staged_appimage" "$app_destination"
staged_appimage=''
old_ifs=$IFS
IFS=$newline
for staged_icon in $staged_icons; do
  size_directory=$(dirname -- "$staged_icon")
  mv -f "$staged_icon" "$size_directory/isagi.png"
done
IFS=$old_ifs
staged_icons=''
mv -f "$staged_desktop" "$desktop_destination"
staged_desktop=''

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$applications_directory" || fail 'Isagi was installed, but update-desktop-database failed.'
fi

printf 'Isagi installed at %s\n' "$app_destination"
