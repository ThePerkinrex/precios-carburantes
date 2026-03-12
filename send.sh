#!/bin/bash

set -a
source public.env
source .env
set +a

# 1. Open the master connection in the background
# -M: Master mode, -f: Background, -N: Don't execute remote command
ssh -M -S /tmp/ssh_mux_%h_%p_%r -fN $RPI_SSH_DEST

# 2. Define a helper to use the socket
# This makes every 'ssh' call reuse the master connection
alias ssh="ssh -S /tmp/ssh_mux_%h_%p_%r"
alias scp="scp -o ControlPath=/tmp/ssh_mux_%h_%p_%r"

TEMP_DIR=$(mktemp -d)
for file in systemd/*; do
  envsubst < "$file" > "$TEMP_DIR/$(basename "$file")"
done

ssh $RPI_SSH_DEST "sudo systemctl stop $SYSTEMD_UNITS && echo 'Stopped successfully $SYSTEMD_UNITS'"

scp $BINS $RPI_SSH_DEST:$FILE_DEST/bin/
scp config/* $RPI_SSH_DEST:$FILE_DEST/
scp "$TEMP_DIR"/* $RPI_SSH_DEST:/home/pi/systemd/

rm -rf "$TEMP_DIR"

ssh $RPI_SSH_DEST "sudo systemctl daemon-reload && echo 'Reloaded systemd successfully' && sudo systemctl start $SYSTEMD_UNITS && echo 'Started successfully $SYSTEMD_UNITS'"

ssh $RPI_SSH_DEST "sudo systemctl status $SYSTEMD_UNITS"

# 3. Close the master connection when done
ssh -S /tmp/ssh_mux_%h_%p_%r -O exit $RPI_SSH_DEST
