# aria2 1.37.0

GPL-2.0-or-later; upstream https://github.com/aria2/aria2/tree/release-1.37.0.
Corresponding unmodified source: https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.gz
SHA-256: 8e7021c6d5e8f8240c9cc19482e0c8589540836747744724d86bf8af5a21f0e8.

Windows x64 uses MSYS2 UCRT aria2 1.37.0-8 with OpenSSL and libssh2 1.11.1, replacing the older upstream WinCNG build after a native Windows SFTP handshake regression. Package URLs, versions, SHA-256 checksums and the exact DLL closure are recorded in `src/bin/win32/PACKAGES.json`. Corresponding source recipes: https://github.com/msys2/MINGW-packages/tree/master/mingw-w64-aria2 and package base directories listed in the inventory. Source-only archive: https://repo.msys2.org/mingw/sources/mingw-w64-aria2-1.37.0-8.src.tar.zst . License texts accompany the binaries. The OpenSSL legacy provider (dynamically loaded by upstream aria2) is bundled alongside the executable; OPENSSL_MODULES is set only for its child process. The Mozilla CA bundle matches the Linux build (Alpine ca-certificates 20260909-r0).

macOS arm64 is the existing BioDownloader plugin build (AppleTLS, c-ares, libssh2, SQLite, libxml2, zlib; no external Homebrew dylibs), executable SHA-256 64769b54f45c92d9bbaae657a8d60218db2a52408268b260bdd142be3e31d1e9. It communicates with the application only through CLI/HTTP.

Linux x64 build commands and source checksum are in scripts/prepare-linux-aria.sh. The bundle includes its musl loader and runtime dependencies; PACKAGES.txt records Alpine source package versions. Corresponding Alpine recipes and upstream source URLs: https://gitlab.alpinelinux.org/alpine/aports/-/tree/3.23-stable/main. COPY-ING and the aria2 source archive accompany the runtime.
