# Third-Party Components

BioDownloader invokes the following standalone programs through process, standard I/O, HTTP proxy, or SOCKS proxy boundaries. They are not linked into BioDownloader's proprietary JavaScript application code.

## aria2

- Project: https://github.com/aria2/aria2
- License: GNU General Public License, version 2 or later
- Purpose: HTTP/HTTPS/FTP/SFTP segmented downloads
- Source corresponding to the distributed build must be archived with each release.

## Axel

- Project: https://github.com/axel-download-accelerator/axel
- License: GNU General Public License, version 2 or later
- Purpose: HTTP/HTTPS segmented downloads on desktop platforms
- Source corresponding to the distributed build must be archived with each release.

## Mihomo

- Project: https://github.com/MetaCubeX/mihomo
- License: GNU General Public License, version 3
- Purpose: standalone local HTTP/SOCKS proxy process
- Source corresponding to the distributed build must be archived with each release.

## Distribution Requirements

Before public release, each platform bundle must include:

1. The applicable GPL license texts.
2. Copyright and attribution notices.
3. Exact upstream project, version, source archive or commit, build parameters, and SHA-256 hashes.
4. A written offer or direct URL for obtaining the corresponding source, including any local modifications.
5. Verification that BioDownloader communicates with these programs only through process or protocol boundaries.

This document is an engineering compliance checklist and is not legal advice. Commercial distribution should receive a dedicated license review.
