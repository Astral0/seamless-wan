#!/bin/sh
# seamless-wan: Enter the Alpine Linux chroot
CHROOT=/mnt/data
mountpoint -q $CHROOT/proc || mount -t proc proc $CHROOT/proc
mountpoint -q $CHROOT/sys || mount -t sysfs sys $CHROOT/sys
mountpoint -q $CHROOT/dev || mount -o bind /dev $CHROOT/dev
mountpoint -q $CHROOT/dev/pts || mount -o bind /dev/pts $CHROOT/dev/pts
echo "nameserver 8.8.8.8" > $CHROOT/etc/resolv.conf
chroot $CHROOT /bin/bash
