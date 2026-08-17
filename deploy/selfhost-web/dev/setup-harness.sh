#!/bin/sh
# Throwaway verification harness. NOT part of the shipped page.
set -eux
cd "$(dirname "$0")"
ISO=alpine-virt-3.23.5-x86.iso
[ -f "$ISO" ] || curl -sO "https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/x86/$ISO"
[ -d iso ] || { mkdir iso && bsdtar -xf "$ISO" -C iso; }
# A local package.json is required so `npm install` treats dev/ as its own
# project root instead of walking up into the multica monorepo's pnpm
# workspace (whose package.json deps use pnpm's "catalog:" protocol, which
# npm cannot parse — confirmed: without this, `npm install v86@latest`
# fails with EUNSUPPORTEDPROTOCOL). Regenerated here rather than committed,
# per the file list for this task (setup-harness.sh/harness.html/
# verify-net.mjs/NOTES.md only).
[ -f package.json ] || printf '{ "name": "selfhost-verify-harness", "private": true }\n' > package.json
[ -d node_modules/v86 ] || npm install v86@latest
mkdir -p bios
[ -f bios/seabios.bin ] || curl -sL -o bios/seabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/seabios.bin
[ -f bios/vgabios.bin ] || curl -sL -o bios/vgabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/vgabios.bin
[ -d node_modules/playwright ] || npm install playwright
# Sparse empty 2 GiB disk image for harness-luks.html's `hda` (Task 6). A
# real, apparent-2GiB-but-0-actual-blocks file (confirmed via `du`), served
# with HTTP Range support by verify-luks.mjs's static server and loaded by
# v86 with `async: true` — demand-paged over Range requests, never fully
# read into memory. See dev/NOTES.md "Task 6" section for why this replaces
# the brief's `buffer: new ArrayBuffer(2 * 1024 ** 3)` suggestion.
[ -f empty-disk.img ] || truncate -s 2147483648 empty-disk.img
echo "harness ready"
