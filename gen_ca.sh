#!/bin/bash

set -a
source public.env
source .env
set +a


mkdir -p certs
openssl genrsa -out certs/ca.key 2048
openssl req -new -x509 -days 3650 -key certs/ca.key -out certs/ca.crt -subj "/CN=carburantes-CA"

echo "Created CA"
