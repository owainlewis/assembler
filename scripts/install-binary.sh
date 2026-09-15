#!/bin/sh
set -eu
# Install an already-downloaded release. No downloads, sudo, or shell-profile edits.
assembler_source=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
assembler_prefix=${1:-"$HOME/.local"}
assembler_version=$("$assembler_source/runtime/node" -p 'process.platform + "-" + process.arch')
assembler_version=$(tr -d '\n' < "$assembler_source/VERSION")-$assembler_version
case "$assembler_prefix" in /*) ;; *) echo 'Use an absolute installation prefix' >&2; exit 1 ;; esac
assembler_destination=$assembler_prefix/lib/assembler/$assembler_version
assembler_link=$assembler_prefix/bin/assembler
if [ -e "$assembler_destination" ] || [ -L "$assembler_destination" ]; then
  echo "Release already exists: $assembler_destination" >&2; exit 1
fi
if [ -e "$assembler_link" ] || [ -L "$assembler_link" ]; then
  if [ ! -L "$assembler_link" ]; then echo "Refusing to replace existing command: $assembler_link" >&2; exit 1; fi
  case "$(readlink "$assembler_link")" in
    "$assembler_prefix"/lib/assembler/*/bin/assembler) ;;
    *) echo "Refusing to replace an unmanaged command: $assembler_link" >&2; exit 1 ;;
  esac
fi
mkdir -p "$assembler_prefix/lib/assembler" "$assembler_prefix/bin"
cp -R "$assembler_source" "$assembler_destination"
ln -sfn "$assembler_destination/bin/assembler" "$assembler_link"
echo "Installed $assembler_link"
echo "Ensure $assembler_prefix/bin is on PATH. Older installed releases are retained."
