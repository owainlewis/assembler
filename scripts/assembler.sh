#!/bin/sh
set -eu
# Resolve the installed symlink without changing the caller's working directory.
assembler_launcher=$0
while [ -L "$assembler_launcher" ]; do
  assembler_parent=$(CDPATH= cd -- "$(dirname -- "$assembler_launcher")" && pwd)
  assembler_launcher=$(readlink "$assembler_launcher")
  case "$assembler_launcher" in /*) ;; *) assembler_launcher=$assembler_parent/$assembler_launcher ;; esac
done
assembler_root=$(CDPATH= cd -- "$(dirname -- "$assembler_launcher")/.." && pwd)
exec "$assembler_root/runtime/node" "$assembler_root/app/dist/cli.js" "$@"
