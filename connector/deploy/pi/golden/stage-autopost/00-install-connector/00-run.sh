#!/bin/bash -e
# HOST side: stage the connector tarball + service units + polkit rule into the image's /tmp for the chroot step.
# build-golden.sh has already produced files/connector.tar.gz from the current repo.
install -d "${ROOTFS_DIR}/tmp/autopost"
install -m 0644 files/connector.tar.gz            "${ROOTFS_DIR}/tmp/autopost/connector.tar.gz"
install -m 0644 files/autopost-claim.service      "${ROOTFS_DIR}/tmp/autopost/autopost-claim.service"
install -m 0644 files/50-autopost-nm.rules        "${ROOTFS_DIR}/tmp/autopost/50-autopost-nm.rules"
