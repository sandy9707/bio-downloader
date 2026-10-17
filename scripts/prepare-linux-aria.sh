#!/usr/bin/env bash
set -euo pipefail
# Alpine's musl loader + dependency closure runs independently of host glibc.
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK_OUT="$TASK_ROOT/dist/aria2-portable"
mkdir -p "$TASK_OUT"
docker run --rm -v "$TASK_OUT:/out" alpine:3.23 sh -ec '
 apk add --no-cache aria2 ca-certificates
 mkdir -p /out/lib
 cp /usr/bin/aria2c /out/aria2c.bin
 ldd /usr/bin/aria2c | awk '\''/=> \// {print $3} /^\s*\// {print $1}'\'' | while read -r lib; do cp -L "$lib" /out/lib/; done
 cp -L /lib/ld-musl-x86_64.so.1 /out/lib/
 cp /etc/ssl/certs/ca-certificates.crt /out/ca-certificates.crt
 apk info -vv > /out/PACKAGES.txt
'
cat > "$TASK_OUT/aria2c" <<'WRAPPER'
#!/bin/sh
ARIA_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$ARIA_DIR/lib/ld-musl-x86_64.so.1" --library-path "$ARIA_DIR/lib" "$ARIA_DIR/aria2c.bin" --ca-certificate="$ARIA_DIR/ca-certificates.crt" "$@"
WRAPPER
chmod 755 "$TASK_OUT/aria2c" "$TASK_OUT/aria2c.bin" "$TASK_OUT/lib/ld-musl-x86_64.so.1"
"$TASK_OUT/aria2c" --version
# Replace obsolete glibc 2.38 dependencies only after the new engine runs.
rm -rf "$TASK_ROOT/bin/linux/aria2"
cp -R "$TASK_OUT" "$TASK_ROOT/bin/linux/aria2"
