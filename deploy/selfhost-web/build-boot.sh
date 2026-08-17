#!/bin/sh
# Builds boot/vmlinuz + boot/initramfs.img inside a linux/386 Alpine container.
# The initramfs carries our /init (guest/init-selfhost), provision.sh, cryptsetup,
# btrfs tools, apk.static and the kernel modules needed to reach the encrypted root.
set -eux
cd "$(dirname "$0")"
KERNEL_PKG="${KERNEL_PKG:-linux-virt}"   # decided by the module check (Task 4, Step 2)
export KERNEL_PKG

# NOTE: the `multica` Lima VM mounts the host home directory read-only
# (~/.lima/multica/lima.yaml: `mounts: [{location: "~", writable: false}]`).
# deploy/selfhost-web lives under $HOME, so a bind-mounted *write* target
# (`-v $PWD/boot:/out`) fails inside the container with "Read-only file
# system" even though the mount itself succeeds and reads work fine (the
# `-v guest:/guest:ro` *input* mount is unaffected — only writes fail).
# Route around it: build into a directory inside the container (not
# bind-mounted), then pull the two output files out with `docker cp`, which
# goes through the Docker API/daemon rather than the VM's bind-mount
# filesystem. Also: `docker run <img> sh -eux <<EOF` only works with `-i`
# (stdin attached) — and `docker create` cannot consume a heredoc at create
# time (the CMD runs later, at `docker start`, by which point stdin is
# gone) — so the build script is written to a host tempfile and `docker cp`
# into the container before `docker start`. See dev/NOTES.md.
SCRIPT="$(mktemp)"
trap 'rm -f "$SCRIPT"' EXIT
cat > "$SCRIPT" <<'EOF'
apk add --no-cache "$KERNEL_PKG" mkinitfs cryptsetup btrfs-progs apk-tools-static
KVER="$(basename /lib/modules/*)"
# Extra content shipped inside the initramfs. NOTE: mkinitfs's real
# "extra files" convention is /etc/mkinitfs/features.d/<name>.files (one
# path per line), with <name> added to the `features=` list below — NOT
# /etc/mkinitfs/files.d/<name> as an earlier draft of this script assumed.
# The wrong path is silently ignored (no error, no warning), so verify
# apk.static/provision.sh landed in the built image after any change here.
# See dev/NOTES.md.
mkdir -p /etc/mkinitfs/features.d /out
# NOTE (Task 6 finding, see dev/NOTES.md): mkinitfs's own "btrfs" feature
# (features.d/btrfs.files) ships only /sbin/btrfs, NOT /sbin/mkfs.btrfs —
# a separate real binary in btrfs-progs (different file size, not a
# symlink/multicall dispatch onto `btrfs`), needed by provision.sh's
# `mkfs.btrfs` call. Confirmed empirically: without it explicitly listed
# here, boot-testing hit "mkfs.btrfs: not found" right after a successful
# cryptsetup luksFormat/open. Added below alongside the other selfhost-only
# extra files.
# NOTE (Task 7 finding, see dev/NOTES.md): stage2_install (guest/provision.sh)
# bootstraps a whole new Alpine root under --root /mnt with apk.static.
# apk resolves its trusted-keys directory as $ROOT/etc/apk/keys (relative
# to --root), not this initramfs's own real /etc/apk/keys — a freshly
# --initdb'd root has no keys dir yet, so a bare `apk.static --root /mnt
# add ...` fails every package with "UNTRUSTED signature" (confirmed
# empirically). Fix: ship the build container's own trusted Alpine signing
# keys (from the alpine-keys package, already present in this base image)
# into the initramfs so stage2_install can copy them into /mnt/etc/apk/keys
# before its apk.static call — avoids needing --allow-untrusted for the
# CDN package set. mkinitfs's feature_files() glob-expands each line
# (confirmed by reading /sbin/mkinitfs), so a wildcard here is fine.
# NOTE (Task 8 finding, see dev/NOTES.md): stage3_multica (guest/provision.sh)
# `cp`s /guest/multica-backend.initd and /guest/multica-web.initd into
# /mnt/etc/init.d/ at provisioning time — same reasoning as provision.sh
# itself needing to be listed here (mkinitfs's features.d mechanism is the
# only way anything under guest/ actually lands in the built initramfs;
# omitting an entry here is a silent no-op, not a build failure, per the
# Task 4 finding above).
printf '/sbin/apk.static\n/sbin/mkfs.btrfs\n/etc/apk/keys/*.rsa.pub\n/guest/provision.sh\n/guest/multica-backend.initd\n/guest/multica-web.initd\n' > /etc/mkinitfs/features.d/selfhost.files
cp /guest/init-selfhost /usr/share/mkinitfs/initramfs-init  # replace stock init
# NOTE (Task 6 finding, see dev/NOTES.md): "ata" only pulls in the ATA/IDE
# transport drivers (kernel/drivers/ata/*), NOT the SCSI disk block driver
# (kernel/drivers/scsi/sd_mod.ko, gated behind mkinitfs's separate "scsi"
# feature). Without it, the disk attached to v86 as `hda` (which v86
# exposes over IDE/ATA, not virtio-blk — it has no virtio block device at
# all) is detected at the SCSI transport layer (`scsi 0:0:0:0:
# Direct-Access ...` in dmesg) but no /dev/sda block device node is ever
# created — confirmed empirically: cryptsetup failed "Device /dev/sda does
# not exist", and /proc/partitions and /sys/class/block were both empty
# until "scsi" was added here.
echo 'features="base virtio ata scsi ext4 btrfs cryptsetup network dhcp selfhost"' > /etc/mkinitfs/mkinitfs.conf
mkinitfs -o /out/initramfs.img "$KVER"
cp /boot/vmlinuz-* /out/vmlinuz
EOF

CONTAINER="selfhost-build-boot-$$"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker create --platform linux/386 -e KERNEL_PKG --name "$CONTAINER" \
  -v "$PWD/guest:/guest:ro" alpine:3.23 sh -eux /build.sh
docker cp "$SCRIPT" "$CONTAINER:/build.sh"
docker start -a "$CONTAINER"
docker cp "$CONTAINER:/out/initramfs.img" boot/initramfs.img
docker cp "$CONTAINER:/out/vmlinuz" boot/vmlinuz
docker rm -f "$CONTAINER" >/dev/null
chmod 644 boot/initramfs.img boot/vmlinuz  # docker cp can land initramfs.img at 600; needs to be servable over HTTP
ls -la boot/
