#!/bin/sh
# seamless-wan: Launch Claude Code in Alpine chroot as user claude
CHROOT=/mnt/data
if ! mountpoint -q /mnt/data; then
    mount /dev/mmcblk0p3 /mnt/data
fi
mountpoint -q $CHROOT/proc || mount -t proc proc $CHROOT/proc
mountpoint -q $CHROOT/sys || mount -t sysfs sys $CHROOT/sys
mountpoint -q $CHROOT/dev || mount -o bind /dev $CHROOT/dev
mountpoint -q $CHROOT/dev/pts || mount -o bind /dev/pts $CHROOT/dev/pts
echo "nameserver 8.8.8.8" > $CHROOT/etc/resolv.conf
chroot $CHROOT /bin/su -l claude -c "/home/claude/.local/bin/claude --dangerously-skip-permissions $*"
