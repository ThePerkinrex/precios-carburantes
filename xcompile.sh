#!/bin/bash

set -a
source public.env
source .env
set +a

PREV="$(du -sh $BINS)"
# Linux raspberrypi 6.12.62+rpt-rpi-v8 #1 SMP PREEMPT Debian 1:6.12.62-1+rpt1 (2025-12-18) aarch64 GNU/Linux

cargo build -r --target aarch64-unknown-linux-gnu

echo "Previously"
echo "$PREV"

echo "Now"
du -sh $BINS
