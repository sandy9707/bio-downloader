#!/usr/bin/env bash
set -euo pipefail
# Unmodified upstream sources, static musl + OpenSSL: no libssl.so.10 dependency.
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK_BUILD="$TASK_ROOT/dist/linux-axel-source"
mkdir -p "$TASK_BUILD"
cd "$TASK_BUILD"
curl -fL --retry 3 -o axel.tar.gz https://github.com/axel-download-accelerator/axel/releases/download/v2.17.14/axel-2.17.14.tar.gz
curl -fL --retry 3 -o openssl.tar.gz https://github.com/openssl/openssl/releases/download/openssl-3.6.4/openssl-3.6.4.tar.gz
printf '%s\n' '575f73f640ee836a95d27b54aeed216c45bc1e914cad92da6f00b907d1c94925  axel.tar.gz' '9bffaa1ad1e07b354c21bd3324ec02fa15579f45a7d0494b3e74bc449b7333ef  openssl.tar.gz' | sha256sum -c -
docker run --rm -v "$TASK_BUILD:/build" -w /build alpine:3.23 sh -ec '
 apk add --no-cache build-base perl pkgconf linux-headers
 tar xzf openssl.tar.gz
 cd openssl-3.6.4
 perl Configure linux-x86_64 no-shared no-tests no-module --openssldir=/etc/ssl
 make -j4 build_libs
 cd /build
 tar xzf axel.tar.gz
 cd axel-2.17.14
 SSL_CFLAGS="-I/build/openssl-3.6.4/include" SSL_LIBS="/build/openssl-3.6.4/libssl.a /build/openssl-3.6.4/libcrypto.a -lpthread" LDFLAGS="-static" CFLAGS="-O2" ./configure --disable-nls
 make -j4
 strip axel
 cp axel /build/axel-static
'
cp axel-static "$TASK_ROOT/bin/linux/axel"
chmod 755 "$TASK_ROOT/bin/linux/axel"
"$TASK_ROOT/bin/linux/axel" --version
