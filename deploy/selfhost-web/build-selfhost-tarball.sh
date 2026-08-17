#!/bin/sh
# Builds the 386 payload the guest downloads on first boot.
# Backend: trivial Go cross-compile. Frontend: `next build` output is
# arch-neutral JS; we build on the host, then source-build `sharp` (the one
# native module Next traces in — see the big comment below) for the guest's
# exact target (Alpine musl linux/386), and VERIFY every native .node
# binary that ends up in the staged output is actually linux/386 (spec §7
# risk). Also source-builds `pgvector` for PostgreSQL 17 (Alpine v3.23's CDN
# `postgresql-pgvector` package only supports postgresql18 — see the
# pgvector section below and dev/NOTES.md "Task 7") and ships it under
# `pgvector-pg17/` for Task 8 to install offline, same reasoning as sharp.
set -eux
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$PWD/multica-selfhost-386.tar.gz}"
STAGE="$(mktemp -d)"

# Single consolidated cleanup, success or failure: removes the staging tree
# (~279MB, never wanted after $OUT is written), the sharp/pgvector build
# script tempfiles, and force-removes both build containers by name. Using
# `${VAR:-}` throughout so this is safe to fire even if the script exits
# before a given variable is ever assigned (e.g. a failure during the
# backend build, before $CONTAINER exists) — `set -u` is active, and a bare
# `$CONTAINER` reference at that point would itself abort with "unbound
# variable" instead of cleaning up.
# NOTE: the pgvector build stage (below) uses its own $PGVECTOR_CONTAINER /
# $PGVECTOR_BUILD_SCRIPT variables rather than reusing $CONTAINER/
# $SHARP_BUILD_SCRIPT — the sharp container is intentionally left running
# (not explicitly `docker rm`'d) until this trap fires at script exit, per
# the existing comment below it; reusing the same variable name for a
# second, later container would silently overwrite that reference before
# the trap ever ran, leaking the first (sharp) container forever. Two
# independent variables means both get cleaned up regardless of which
# stage the script fails in.
cleanup() {
  set +e
  [ -n "${SHARP_BUILD_SCRIPT:-}" ] && rm -f "$SHARP_BUILD_SCRIPT"
  [ -n "${SHARP_NODE_FILE:-}" ] && rm -f "$SHARP_NODE_FILE"
  [ -n "${CONTAINER:-}" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1
  [ -n "${PGVECTOR_BUILD_SCRIPT:-}" ] && rm -f "$PGVECTOR_BUILD_SCRIPT"
  [ -n "${PGVECTOR_CONTAINER:-}" ] && docker rm -f "$PGVECTOR_CONTAINER" >/dev/null 2>&1
  [ -n "${STAGE:-}" ] && rm -rf "$STAGE"
}
trap cleanup EXIT

# Backend (GOARCH=386, static)
cd "$REPO_ROOT/server"
CGO_ENABLED=0 GOOS=linux GOARCH=386 go build -ldflags "-s -w" -o "$STAGE/backend/server" ./cmd/server
CGO_ENABLED=0 GOOS=linux GOARCH=386 go build -ldflags "-s -w" -o "$STAGE/backend/migrate" ./cmd/migrate
cp -r migrations "$STAGE/backend/migrations"

# Frontend (standalone)
cd "$REPO_ROOT"
pnpm install --frozen-lockfile
# NOTE: apps/web's package.json name is "@multica/web" (not "web") — see
# Dockerfile.web's `pnpm --filter @multica/web build`, which is the real
# production build of this same app and confirms both the filter name and
# the standalone-output copy layout below. `pnpm --filter web` also happens
# to resolve via pnpm's substring match, but the exact name is used here to
# avoid relying on that.
STANDALONE=true pnpm --filter @multica/web build

# Next's output-file-tracing root autodetection walks UP from apps/web
# looking for a workspace root (lockfile/pnpm-workspace.yaml) and picks the
# first one found. Normally that's this repo's own root, so
# .next/standalone/apps/web/server.js sits directly under
# .next/standalone/. But when this checkout itself lives inside another
# pnpm workspace on disk (e.g. a git worktree nested under a monorepo
# clone, as in this dev environment: worktree at
# .claude/worktrees/<name>/ inside a checkout that also has a
# pnpm-workspace.yaml at its own root), Next finds that OUTER
# pnpm-workspace.yaml instead and nests the standalone output one or more
# extra directories deep (e.g.
# .next/standalone/.claude/worktrees/<name>/apps/web/server.js).
# `apps/web/server.js`'s path relative to the standalone root is stable
# either way (Next always preserves the app's path *within* whatever root
# it picked), so locate that root by finding server.js and stripping the
# known suffix, instead of assuming "$REPO_ROOT/apps/web/.next/standalone"
# is already rooted correctly. In the normal (non-nested) case this
# resolves to exactly apps/web/.next/standalone, so it's a no-op there.
SERVER_JS="$(find apps/web/.next/standalone -type f -path '*/apps/web/server.js')"
# Guard the empty and multi-match cases before trusting $SERVER_JS: an
# empty result would leave STANDALONE_ROOT empty, turning the `cp -r
# "$STANDALONE_ROOT/." "$STAGE/frontend"` below into `cp -r "/." ...` —
# silently copying the host root filesystem into the tarball staging area.
# A multi-match result (more than one apps/web/server.js anywhere under
# .next/standalone) would make the later `%apps/web/server.js` suffix-strip
# ambiguous/wrong. Both fail loudly instead.
if [ -z "$SERVER_JS" ]; then
  echo "ERROR: no apps/web/server.js found under apps/web/.next/standalone — Next.js standalone build output missing or layout changed" >&2
  exit 1
fi
if [ "$(printf '%s\n' "$SERVER_JS" | wc -l)" -ne 1 ]; then
  echo "ERROR: expected exactly one apps/web/server.js under apps/web/.next/standalone, found:" >&2
  printf '%s\n' "$SERVER_JS" >&2
  exit 1
fi
STANDALONE_ROOT="${SERVER_JS%apps/web/server.js}"
cp -r "$STANDALONE_ROOT/." "$STAGE/frontend"
cp -r apps/web/.next/static "$STAGE/frontend/apps/web/.next/static"
cp -r apps/web/public "$STAGE/frontend/apps/web/public" 2>/dev/null || true

# --- next's own hoisted runtime deps (JS-only), missing from any path ----
# --- Node's real module resolution can actually reach ---------------------
# NOTE (Task 8 boot-test finding, see dev/NOTES.md "Task 8" — bug found in
# THIS script, fixed here since it blocks Task 8's own boot-test gate):
# Next's output-file-tracing, for this repo/pnpm layout, copies `next`'s
# own transitive runtime deps (`@swc/helpers`, `@next/env`, confirmed via
# a full local repro of `node server.js` against the extracted tarball —
# see dev/NOTES.md) ONLY into the pnpm virtual-store shape
# (`node_modules/.pnpm/next@<hash>/node_modules/<pkg>`), never at a path
# Node's real upward node_modules walk from `apps/web/node_modules/next/
# dist/**/*.js` can actually reach — that walk checks `next/node_modules`
# next, then `apps/web/node_modules`, then further up; none of the traced
# locations. In a normal pnpm install these resolve because pnpm HOISTS
# them (confirmed: `readlink node_modules/@swc/helpers` in the source
# tree points into the repo ROOT's own node_modules/.pnpm) — the
# standalone tracer doesn't reconstruct that hoisting. Confirmed
# empirically: without this fix, the frontend crashes immediately with
# `Cannot find module '@swc/helpers/_/_interop_require_default'`, then
# (once that's fixed in isolation) `Cannot find module '@next/env'` —
# this is systemic (next's whole private dependency set), not one
# one-off missing package, so this fixes the class rather than each
# instance as it's separately discovered.
#
# Fix: mirror what a real pnpm-managed `next/node_modules/` would contain
# — every sibling package `next`'s own pnpm-hash directory resolved for
# itself — by copying them into `apps/web/node_modules/next/node_modules/`
# (the FIRST place Node's walk checks right after `next/dist/**`, so this
# fixes every such lookup uniformly). Deliberately EXCLUDES `next` itself
# (nesting the package inside its own node_modules is meaningless) and
# `sharp` (handled by its own dedicated linux/386 overlay below — copying
# next's traced darwin-arm64 sharp copy here would shadow that overlay
# for any require('sharp') reached through next's own internals, since
# this location resolves BEFORE the locations the sharp overlay logic
# below targets; excluding it here avoids ever staging a second,
# wrong-arch copy in the first place — the sharp overlay's own `find`,
# which runs after this block, only walks the frontend tree as it
# actually is by that point).
NEXT_PNPM_DIRS="$(find "$STAGE/frontend" -type d -path '*/node_modules/.pnpm/next@*/node_modules')"
if [ -z "$NEXT_PNPM_DIRS" ]; then
  echo "ERROR: could not find next's own pnpm virtual-store node_modules directory in staged frontend output — cannot fix its missing transitive deps" >&2
  exit 1
fi
if [ "$(printf '%s\n' "$NEXT_PNPM_DIRS" | wc -l)" -ne 1 ]; then
  echo "ERROR: expected exactly one next@<hash>/node_modules directory in staged frontend output, found:" >&2
  printf '%s\n' "$NEXT_PNPM_DIRS" >&2
  exit 1
fi
NEXT_APP_NODE_MODULES="$STAGE/frontend/apps/web/node_modules/next/node_modules"
mkdir -p "$NEXT_APP_NODE_MODULES"
for pkg in "$NEXT_PNPM_DIRS"/*; do
  base="$(basename "$pkg")"
  [ "$base" = "next" ] && continue
  [ "$base" = "sharp" ] && continue
  cp -r "$pkg" "$NEXT_APP_NODE_MODULES/"
done
# Guard: assert the two packages that actually crashed the frontend during
# boot-testing are now resolvable at the fixed location — don't let a
# layout change pass silently, same discipline as every other guard in
# this script.
for required in "@swc/helpers/cjs/_interop_require_default.cjs" "@next/env"; do
  if [ ! -e "$NEXT_APP_NODE_MODULES/$required" ]; then
    echo "ERROR: $required still missing from $NEXT_APP_NODE_MODULES after the fix-up copy" >&2
    exit 1
  fi
done

# --- sharp for linux/386 ------------------------------------------------
# `sharp` is a Next.js optionalDependency (the next/image optimizer), not
# something apps/web declares itself. Next's file tracer bundled the build
# host's native binding (@img/sharp-darwin-arm64) into the standalone
# output. sharp has NO published linux-ia32 prebuilt at all (checked the
# full @img/sharp-* platform matrix in pnpm-lock.yaml: darwin-arm64/x64,
# linux-arm64/arm/ppc64/riscv64/s390x/x64, linuxmusl-arm64/x64, wasm32,
# win32-arm64/ia32/x64 — no linux-ia32). Spec owner's ruling: source-build
# it (option a in NOTES.md), targeting exactly what the guest is —
# Alpine/musl linux/386 — inside a `--platform linux/386 alpine:3.23`
# container, matching the guest's own OS+arch+libc so the build environment
# IS the runtime environment. Alpine 3.23 ships vips-dev 8.17.3-r1, which
# satisfies sharp's own declared minimum (`"config": {"libvips": ">=8.17.3"}`
# in sharp/package.json) — no manual libvips cross-build needed.
SHARP_VERSION="$(cd "$REPO_ROOT" && node -e "console.log(require('sharp/package.json').version)")"
SHARP_BUILD_SCRIPT="$(mktemp)"
# (cleanup is the single consolidated trap set at the top of this script —
# setting another EXIT trap here would silently REPLACE it, not add to it)
cat > "$SHARP_BUILD_SCRIPT" <<EOF
set -eux
apk update
apk add --no-cache nodejs npm python3 make g++ vips-dev pkgconf
mkdir -p /build /out/sharp-ia32 /out/vips-apks
cd /build
npm init -y >/dev/null
export SHARP_FORCE_GLOBAL_LIBVIPS=1
# node-addon-api/node-gyp are sharp's own from-source build prerequisites
# (sharp's install script requires them but doesn't declare them as its own
# deps — see its install/build.js). Installed in the SAME npm install as
# sharp itself: a separate unsaved install followed by a second install
# lets npm prune the first as extraneous once it reconciles against
# package.json, silently breaking the build (hit this empirically).
npm install --build-from-source --foreground-scripts sharp@${SHARP_VERSION} node-addon-api node-gyp
node -e "require('sharp')"
cp /build/node_modules/sharp/src/build/Release/sharp-linuxmusl-ia32.node /out/sharp-ia32/
# vips-cpp is a SEPARATE Alpine subpackage from vips (libvips-cpp.so.42,
# the C++ ABI sharp's binding links against, is not part of the base
# "vips" runtime package) — verified empirically: omitting it produces
# "ERR_DLOPEN_FAILED: Error loading shared library libvips-cpp.so.42" at
# require('sharp') time even with "vips" installed. Fetch both as actual
# .apk files (not installed here) so the guest can install them offline
# from the tarball with no CDN access at provisioning time (spec owner's
# ruling — see NOTES.md interface note for Tasks 7/8).
apk fetch -R -o /out/vips-apks vips vips-cpp
ls -la /out/vips-apks
EOF
CONTAINER="selfhost-sharp-ia32-$$"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker create --platform linux/386 --name "$CONTAINER" alpine:3.23 sh -eux /build.sh
docker cp "$SHARP_BUILD_SCRIPT" "$CONTAINER:/build.sh"
docker start -a "$CONTAINER"
SHARP_NODE_FILE="$(mktemp)"
docker cp "$CONTAINER:/out/sharp-ia32/sharp-linuxmusl-ia32.node" "$SHARP_NODE_FILE"
docker cp "$CONTAINER:/out/vips-apks" "$STAGE/vips-apks"
# Container removal (and $SHARP_BUILD_SCRIPT/$SHARP_NODE_FILE cleanup) is
# now handled uniformly by the `cleanup` trap above — no explicit `docker
# rm -f` here, so the container also gets cleaned up if a LATER step
# (overlay, guard, tar) fails, not just on this happy path.
export SHARP_NODE_FILE

# The docker cp above silently creates an empty destination file if the
# container-side source path didn't exist (e.g. the build produced no
# .node at all due to an upstream change) — assert it's actually got
# content before using it as the overlay source.
if [ ! -s "$SHARP_NODE_FILE" ]; then
  echo "ERROR: sharp-linuxmusl-ia32.node was not produced by the build container (empty/missing after docker cp) — nothing to overlay" >&2
  exit 1
fi

# Overlay: replace the wrong-arch native packages Next traced in with our
# linux/386 build. sharp's own module resolution
# (lib/sharp.js: `../src/build/Release/sharp-${runtimePlatform}.node`)
# tries this from-source location BEFORE any `@img/sharp-<platform>`
# prebuilt package, so dropping our .node there is enough — the prebuilt
# @img/sharp-* native packages become unreachable dead weight and are
# removed outright (not just ignored) so the guard below has nothing wrong
# left to trip on.
# (collect matches into a variable before deleting anything — `find`
# deleting a directory mid-traversal via `-exec rm -rf` races its own
# tree-walk and can abort with "fts_read: No such file or directory")
for f in $(find "$STAGE/frontend" -path '*/@img/sharp-*' -name '*.node'); do
  rm -rf "$(dirname "$(dirname "$f")")"
done

# Guard against a vacuous overlay: if Next's output layout ever changes
# such that no `sharp/lib/sharp.js` is found, the loop below would simply
# do nothing — the wrong-arch binaries above are already deleted, so the
# guard later would see zero .node files and pass "cleanly", shipping a
# tarball with next/image's sharp dependency silently missing its native
# binding entirely. Assert there's at least one real target before (and
# after) doing the overlay, rather than let that pass silently.
SHARP_JS_PATHS="$(find "$STAGE/frontend" -type f -path '*/sharp/lib/sharp.js')"
if [ -z "$SHARP_JS_PATHS" ]; then
  echo "ERROR: no sharp/lib/sharp.js found in staged frontend output — sharp overlay has no target (Next.js standalone layout changed, or sharp is no longer traced in); refusing to produce a tarball with sharp silently missing its native binding" >&2
  exit 1
fi
EXPECTED_OVERLAY_COUNT="$(printf '%s\n' "$SHARP_JS_PATHS" | wc -l | tr -d ' ')"
for f in $SHARP_JS_PATHS; do
  d="$(dirname "$(dirname "$f")")/src/build/Release"
  mkdir -p "$d"
  cp "$SHARP_NODE_FILE" "$d/sharp-linuxmusl-ia32.node"
done

PLACED_COUNT="$(find "$STAGE/frontend" -path '*/sharp/src/build/Release/sharp-linuxmusl-ia32.node' | wc -l | tr -d ' ')"
if [ "$PLACED_COUNT" -eq 0 ]; then
  echo "ERROR: sharp overlay placed zero .node files — the tarball would ship sharp with no native binding at all" >&2
  exit 1
fi
if [ "$PLACED_COUNT" -ne "$EXPECTED_OVERLAY_COUNT" ]; then
  echo "ERROR: sharp overlay placed $PLACED_COUNT .node files but expected $EXPECTED_OVERLAY_COUNT (one per sharp/lib/sharp.js found) — partial overlay failure" >&2
  exit 1
fi

# Native-module guard: every .node file remaining in the staged output must
# actually be linux/386 (not "must not exist" — sharp's overlay above is a
# deliberate, verified-correct native module for the guest's own arch/libc;
# a bare "any .node = fail" guard would reject legitimate output).
OFFENDERS=""
for f in $(find "$STAGE/frontend" -name '*.node'); do
  FILE_OUT="$(file "$f")"
  case "$FILE_OUT" in
    *"ELF 32-bit"*"Intel 80386"*) ;;
    *) OFFENDERS="$OFFENDERS
$f: $FILE_OUT" ;;
  esac
done
if [ -n "$OFFENDERS" ]; then
  echo "ERROR: non-linux/386 native modules found in standalone output:" >&2
  echo "$OFFENDERS" >&2
  exit 1
fi

# --- pgvector for PostgreSQL 17, source-built, offline payload -----------
# Task 7 shipped stage2_install with PostgreSQL 17 but NO pgvector: Alpine
# v3.23's `postgresql-pgvector` CDN package has a hard dependency on
# `postgresql18` (confirmed via `apk info -R postgresql-pgvector`), no
# `postgresql17-pgvector` variant exists at all, and installing the CDN
# package anyway would silently drag in a second, incompatible Postgres
# major (see deploy/selfhost-web/dev/NOTES.md "Task 7" BLOCKING FINDING
# section for the full writeup, including why "just repoint the alternatives
# default back to 17" doesn't fix the underlying ABI mismatch). Spec owner's
# ruling on that blocker: keep the project's Postgres pin at 17, source-build
# pgvector for it here, and ship it as a pinned offline payload — the same
# pattern this script already uses for `vips`/`sharp` above. Task 8 installs
# it into /mnt before the guest ever runs `create extension vector`.
#
# Pinned version: latest pgvector release tag at the time of this build
# (checked via `curl https://api.github.com/repos/pgvector/pgvector/tags` —
# pgvector does not use GitHub's "Releases" feature, only tags, so the
# `/releases/latest` endpoint 404s; the tags list is the correct source of
# truth). Update this pin deliberately, not silently, if pgvector cuts a new
# release later.
PGVECTOR_VERSION="v0.8.6"

PGVECTOR_BUILD_SCRIPT="$(mktemp)"
cat > "$PGVECTOR_BUILD_SCRIPT" <<EOF
set -eux
apk update
apk add --no-cache postgresql17 postgresql17-dev build-base git
# NOTE (see dev/NOTES.md "Task 7" section for the full empirical trail):
# Alpine's generic /usr/bin/pg_config always reports libpq-dev's own
# version (currently 18.x — libpq is a single, unversioned package shared
# across all installed Postgres majors) — postgresql-common's own
# version-alternatives mechanism (\`pg_versions\`) can't repoint it, because
# libpq-dev ships /usr/bin/pg_config as a real file, not a symlink it can
# retarget (apk's own install output warns: "pg_versions: WARN:
# /usr/bin/pg_config exists and it's not a symlink!"). The correct,
# version-specific tool is /usr/libexec/postgresql<N>/pg_config, shipped
# directly by the postgresql<N> package itself (confirmed:
# /usr/libexec/postgresql17/pg_config reports "PostgreSQL 17.11",
# --pkglibdir /usr/lib/postgresql17, --sharedir /usr/share/postgresql17,
# --pgxs under /usr/lib/postgresql17/pgxs/...) — use that explicitly so
# pgvector's PGXS-based Makefile builds and installs against postgresql17's
# actual headers/pgxs/pkglibdir, not whichever major libpq-dev happens to
# track.
PG_CONFIG=/usr/libexec/postgresql17/pg_config
git clone --branch $PGVECTOR_VERSION --depth 1 https://github.com/pgvector/pgvector.git /build/pgvector
cd /build/pgvector
# NOTE (Task 8 boot-test finding, see dev/NOTES.md "Task 8" — bug found in
# THIS script, fixed here since it blocks Task 8's own boot-test gate):
# pgvector's Makefile defaults OPTFLAGS to "-march=native" (its own comment:
# "To compile for portability, run: make OPTFLAGS=\"\""). Building inside
# this --platform linux/386 Docker container (itself running under
# qemu-i386/binfmt emulation on the Lima VM's host, per build-boot.sh's own
# notes on this same platform combination), "-march=native" picks up
# whatever CPU features gcc's -march=native probing reports THROUGH that
# emulation layer — which is NOT the same instruction set v86 (this
# project's actual target emulator for the shipped guest) implements.
# Confirmed empirically: without this fix, `create extension vector;`
# crashed the whole Postgres backend with "trap invalid opcode ... in
# vector.so" / "terminated by signal 4: Illegal instruction" the moment
# pgvector's ifunc-based SIMD dispatch (target_clones, selected via
# OPTFLAGS) picked a code path v86's emulated CPU can't execute. Building
# with OPTFLAGS="" instead (pgvector's own documented portability flag)
# disables that CPU-specific dispatch/optimization entirely, producing a
# single portable code path — confirmed via boot-test that this fixes the
# crash (see dev/NOTES.md for the passing run).
make PG_CONFIG="\$PG_CONFIG" OPTFLAGS=""
mkdir -p /out
make install PG_CONFIG="\$PG_CONFIG" OPTFLAGS="" DESTDIR=/out
strip /out/usr/lib/postgresql17/vector.so
# Collect only the runtime artifacts Task 8 needs (vector.so, vector.control,
# vector--*.sql) — DESTDIR also produced LLVM bitcode (.bc, for JIT, which
# stage2_install never installs postgresql17-jit for) and C headers (for
# OTHER extensions that want to interoperate with pgvector's types at build
# time, not needed to run pgvector itself) under the same DESTDIR tree;
# neither is copied into the payload.
mkdir -p /out/payload/lib /out/payload/extension
cp /out/usr/lib/postgresql17/vector.so /out/payload/lib/
cp /out/usr/share/postgresql17/extension/vector.control /out/payload/extension/
cp /out/usr/share/postgresql17/extension/vector--*.sql /out/payload/extension/
ls -la /out/payload/lib /out/payload/extension
EOF
PGVECTOR_CONTAINER="selfhost-pgvector-pg17-$$"
docker rm -f "$PGVECTOR_CONTAINER" >/dev/null 2>&1 || true
docker create --platform linux/386 --name "$PGVECTOR_CONTAINER" alpine:3.23 sh -eux /build.sh
docker cp "$PGVECTOR_BUILD_SCRIPT" "$PGVECTOR_CONTAINER:/build.sh"
docker start -a "$PGVECTOR_CONTAINER"
mkdir -p "$STAGE/pgvector-pg17/lib" "$STAGE/pgvector-pg17/extension"
docker cp "$PGVECTOR_CONTAINER:/out/payload/lib/vector.so" "$STAGE/pgvector-pg17/lib/vector.so"
docker cp "$PGVECTOR_CONTAINER:/out/payload/extension/." "$STAGE/pgvector-pg17/extension/"
# Unlike the sharp container above (which is deliberately left running until
# the final cleanup trap, per its own comment there — later steps there
# don't need it, but leaving it around was simply never a problem worth
# fixing), this container IS removed immediately here: every artifact this
# stage needs (vector.so + extension/*) has already been docker cp'd out by
# this point, nothing downstream reads from this container again, and
# removing it now frees the resources sooner rather than holding it for the
# rest of the (still fairly long, e.g. tar) script. The cleanup trap still
# covers this container too (via $PGVECTOR_CONTAINER) for the failure path —
# clearing the variable right after removal just avoids a harmless
# already-removed `docker rm -f` at exit, not a correctness requirement.
docker rm -f "$PGVECTOR_CONTAINER" >/dev/null 2>&1
PGVECTOR_CONTAINER=""

# Assert non-empty output (same "don't let a layout change pass silently"
# discipline as the sharp overlay/guard above), and that the .so is
# actually the linux/386 target the guest needs.
if [ ! -s "$STAGE/pgvector-pg17/lib/vector.so" ]; then
  echo "ERROR: pgvector build did not produce vector.so (empty/missing after docker cp)" >&2
  exit 1
fi
VECTOR_SO_FILE_OUT="$(file "$STAGE/pgvector-pg17/lib/vector.so")"
case "$VECTOR_SO_FILE_OUT" in
  *"ELF 32-bit"*"Intel 80386"*) ;;
  *) echo "ERROR: pgvector-pg17/lib/vector.so is not linux/386: $VECTOR_SO_FILE_OUT" >&2; exit 1 ;;
esac
if [ ! -s "$STAGE/pgvector-pg17/extension/vector.control" ]; then
  echo "ERROR: pgvector build did not produce vector.control" >&2
  exit 1
fi
PGVECTOR_SQL_COUNT="$(find "$STAGE/pgvector-pg17/extension" -name 'vector--*.sql' | wc -l | tr -d ' ')"
if [ "$PGVECTOR_SQL_COUNT" -eq 0 ]; then
  echo "ERROR: pgvector build produced no vector--*.sql migration files" >&2
  exit 1
fi

git -C "$REPO_ROOT" rev-parse --short HEAD > "$STAGE/VERSION"

# NOTE (Task 8 boot-test finding, see dev/NOTES.md "Task 8" — bug found in
# THIS script, fixed here since it blocks Task 8's own boot-test gate):
# macOS's `cp -r` (used above for backend/migrations, and for the frontend
# standalone copy) and `tar` (bsdtar/libarchive) silently emit AppleDouble
# sidecar files (`._<name>`) alongside real files whenever a source file
# carries any extended attribute/resource-fork metadata (routine on
# APFS/macOS checkouts, e.g. `server/migrations/._001_init.up.sql` next to
# the real `001_init.up.sql`). macOS's own `tar -tf`/extraction is
# copyfile-aware and transparently pairs/hides these, so a build machine
# never notices — but the guest's plain busybox `tar` (no such awareness)
# extracts `._001_init.up.sql` as an ordinary file, and
# `migrations.Files("up")`'s `*.up.sql` glob picks it up as a real
# migration: its content is binary AppleDouble metadata, not SQL, so
# `migrate up` sends it to Postgres and gets back `ERROR: invalid message
# format` — confirmed empirically, first boot-test run of this task hit
# exactly this on migration "001_init". Two-part fix: (1) strip any
# `._*`/`.DS_Store` that snuck into the staging tree from any of the `cp
# -r` steps above, with a hard assert that none remain (same
# don't-pass-silently discipline as every other guard in this script);
# (2) set `COPYFILE_DISABLE=1` for the tar invocation itself so it doesn't
# regenerate them while archiving (belt-and-suspenders — (1) alone would
# already be sufficient, since it runs before tar, but both together match
# how this class of macOS-only bug is conventionally silenced).
find "$STAGE" -name '._*' -delete
find "$STAGE" -name '.DS_Store' -delete
LEFTOVER_APPLEDOUBLE="$(find "$STAGE" -name '._*' | wc -l | tr -d ' ')"
if [ "$LEFTOVER_APPLEDOUBLE" -ne 0 ]; then
  echo "ERROR: $LEFTOVER_APPLEDOUBLE AppleDouble (._*) files remain in the staging tree after cleanup" >&2
  exit 1
fi

COPYFILE_DISABLE=1 tar -czf "$OUT" -C "$STAGE" .
ls -lh "$OUT"
