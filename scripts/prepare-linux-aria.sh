#!/usr/bin/env bash
set -euo pipefail
# Alpine's musl loader + dependency closure runs independently of host glibc.
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK_OUT="$TASK_ROOT/dist/aria2-portable"
mkdir -p "$TASK_OUT"
curl -fL --retry 3 -o "$TASK_OUT/aria2-source.tar.gz" https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.gz
printf '%s\n' '8e7021c6d5e8f8240c9cc19482e0c8589540836747744724d86bf8af5a21f0e8  aria2-source.tar.gz' | (cd "$TASK_OUT" && sha256sum -c -)
docker run --rm -v "$TASK_OUT:/out" alpine:3.23 sh -ec '
 apk add --no-cache build-base pkgconf ca-certificates c-ares-dev libssh2-dev gnutls-dev expat-dev sqlite-dev zlib-dev
 cd /tmp
 tar xzf /out/aria2-source.tar.gz
 cd aria2-1.37.0
 ./configure --with-libssh2 --with-gnutls --without-openssl --without-libxml2 --with-libexpat --disable-nls --without-libgmp --without-libnettle CXXFLAGS="-O2"
 make -j4
 strip src/aria2c
 mkdir -p /out/lib
 cp src/aria2c /out/aria2c.bin
 cp COPYING /out/COPYING
 ldd src/aria2c | awk '\''/=> \// {print $3} /^\s*\// {print $1}'\'' | while read -r lib; do cp -L "$lib" /out/lib/; done
 cp -L /lib/ld-musl-x86_64.so.1 /out/lib/
 cp /etc/ssl/certs/ca-certificates.crt /out/ca-certificates.crt
 apk info -vv > /out/PACKAGES.txt
 chmod 755 /out/aria2c.bin /out/lib/ld-musl-x86_64.so.1
'
cat > "$TASK_OUT/aria2c" <<'WRAPPER'
#!/bin/sh
ARIA_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$ARIA_DIR/lib/ld-musl-x86_64.so.1" --library-path "$ARIA_DIR/lib" "$ARIA_DIR/aria2c.bin" --ca-certificate="$ARIA_DIR/ca-certificates.crt" "$@"
WRAPPER
chmod 755 "$TASK_OUT/aria2c"
"$TASK_OUT/aria2c" --version
# Replace obsolete glibc 2.38 dependencies only after the new engine runs.
rm -rf "$TASK_ROOT/bin/linux/aria2"
cp -R "$TASK_OUT" "$TASK_ROOT/bin/linux/aria2"
