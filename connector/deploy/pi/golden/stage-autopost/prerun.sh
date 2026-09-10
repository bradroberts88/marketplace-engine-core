#!/bin/bash -e
# pi-gen stage guard: ensure the previous stage's rootfs exists before we layer AutoPost onto it.
if [ ! -d "${ROOTFS_DIR}" ]; then
  copy_previous
fi
