# Portable Axel for Apple Silicon

Axel 2.17.14, unmodified upstream source, statically linked with OpenSSL 3.6.4.
Only Apple libSystem is dynamically linked. Deployment target: macOS 11.0.
TLS uses the system CA bundle under /etc/ssl. No Homebrew runtime is required.
The executable is copied from the signed app archive to the user binary directory at startup.

Sources (no local source modifications):
- https://github.com/axel-download-accelerator/axel/releases/download/v2.17.14/axel-2.17.14.tar.gz
- https://github.com/openssl/openssl/releases/download/openssl-3.6.4/openssl-3.6.4.tar.gz

Source SHA-256:
- Axel: 575f73f640ee836a95d27b54aeed216c45bc1e914cad92da6f00b907d1c94925
- OpenSSL: 9bffaa1ad1e07b354c21bd3324ec02fa15579f45a7d0494b3e74bc449b7333ef

Rebuild on Apple Silicon using Xcode command line tools and pkg-config:

```sh
# In the extracted OpenSSL source directory:
export MACOSX_DEPLOYMENT_TARGET=11.0
perl Configure darwin64-arm64-cc no-shared no-tests no-module --openssldir=/etc/ssl -mmacosx-version-min=11.0
make -j8 build_libs
export SSL_SOURCE_DIR="$PWD"
# In the extracted Axel source directory:
SSL_CFLAGS="-I$SSL_SOURCE_DIR/include" SSL_LIBS="$SSL_SOURCE_DIR/libssl.a $SSL_SOURCE_DIR/libcrypto.a" CFLAGS="-O2 -mmacosx-version-min=11.0" ./configure --disable-nls
make -j8
strip axel
codesign --force --sign - axel
otool -L axel
```

Licenses are included alongside the binary. Axel is GPL-2.0-or-later with its upstream OpenSSL linking exception; OpenSSL is Apache-2.0.
