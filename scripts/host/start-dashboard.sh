#!/bin/sh
# seamless-wan: host-side launcher for the web dashboard
# Mounts chroot filesystems and starts the dashboard inside Alpine chroot
CHROOT=/mnt/data
mountpoint -q $CHROOT/proc || mount -t proc proc $CHROOT/proc
mountpoint -q $CHROOT/sys || mount -t sysfs sys $CHROOT/sys
mountpoint -q $CHROOT/dev || mount -o bind /dev $CHROOT/dev
mountpoint -q $CHROOT/dev/pts || mount -o bind /dev/pts $CHROOT/dev/pts
echo "nameserver 8.8.8.8" > $CHROOT/etc/resolv.conf
chroot $CHROOT /opt/start-dashboard.sh
