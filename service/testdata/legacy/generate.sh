#!/bin/bash
# Regenerates the legacy-CA test fixture: a throwaway CA and client cert made
# exactly like the old gen_ca.sh / gen_client_cert.sh (RSA key, SHA-1 SKI,
# client cert with CN only and no OU). Test-only material — never deploy it.
set -euo pipefail
cd "$(dirname "$0")"
rm -f ca.crt ca.key client.crt client.key client.csr ca.srl

openssl genrsa -out ca.key 2048
openssl req -new -x509 -days 36500 -key ca.key -out ca.crt -subj "/CN=test-legacy-CA"

openssl genrsa -out client.key 2048
openssl req -new -key client.key -out client.csr -subj "/CN=alice"
openssl x509 -req -days 36500 -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt
rm -f client.csr ca.srl
