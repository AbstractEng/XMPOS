#!/bin/sh
# Owner step for AGENTS.md authorization 6: installs XMP's SSH key on the Live
# so agents never need its password. You type the password here, once.
#   sh tools/live-mk1/mpc-install-key.sh <live address>
set -eu
cd "$(dirname "$0")/../.."
[ $# -eq 1 ] || { echo "usage: sh tools/live-mk1/mpc-install-key.sh <live address>"; exit 1; }
[ -f artifacts/live-mk1/mpc-ssh-key.pub ] || { echo "no XMP key yet (artifacts/live-mk1/mpc-ssh-key)"; exit 1; }
ssh-copy-id -i artifacts/live-mk1/mpc-ssh-key.pub \
  -o "UserKnownHostsFile=\"$PWD/artifacts/live-mk1/mpc-known-hosts\"" \
  -o StrictHostKeyChecking=accept-new "root@$1"
