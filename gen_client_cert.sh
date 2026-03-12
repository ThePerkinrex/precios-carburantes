#!/bin/bash

set -a
source public.env
source .env
set +a

if [ ! -f "certs/ca.crt" ]; then
    echo "CA does not exist, creating it."
	./gen_ca.sh
fi



read -p "Client cert name: " "name"

mkdir -p "certs/clients/$name"

openssl genrsa -out "certs/clients/$name/$name.key" 2048
openssl req -new -key "certs/clients/$name/$name.key" -out "certs/clients/$name/$name.csr" -subj "/CN=$name"
openssl x509 -req -days 365 -in "certs/clients/$name/$name.csr" -CA certs/ca.crt -CAkey certs/ca.key -CAcreateserial -out "certs/clients/$name/$name.crt"
# Convert to PKCS12 for browser import
openssl pkcs12 -export -out "certs/clients/$name/Carburantes.p12" -inkey "certs/clients/$name/$name.key" -in "certs/clients/$name/$name.crt" -certfile certs/ca.crt

echo "Created certs"
