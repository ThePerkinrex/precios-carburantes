#!/bin/bash

set -a
source public.env
source .env
set +a


scp $BINS $RPI_SSH_DEST:$FILE_DEST/bin/

for file in systemd/*; do
  echo "$file"
  envsubst < "$file" | ssh $RPI_SSH_DEST "cat > /home/pi/systemd/$(basename "$file")"
done

