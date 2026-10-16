# BioDownloader Server for Linux

## Recommended: Web UI

```bash
wget -O BioDownloader-Linux-x64.tar.gz https://biodown.ye.aimeals.cn/downloads/latest/linux
tar -xzf BioDownloader-Linux-x64.tar.gz
cd BioDownloader-Linux-x64
./biodl start
```

The Web UI is recommended for most users. It listens on `0.0.0.0:43280` by default and prints the detected LAN and public URLs. Copy the complete `http://IP:port` address into Chrome or Edge. Do not open it in the Xshell/X-Share file browser.

Downloads are stored in the account that starts the service:

```text
$HOME/Downloads
```

Override the listener or output directory when needed:

```bash
biodl start --host 127.0.0.1 --port 43280
biodl get sra SRR390728 --output /data/raw
```

## CLI

```bash
biodl auth TOKEN
biodl auth 'https://biodown.ye.aimeals.cn/speedup?token=TOKEN'
biodl login
biodl login -u USERNAME
biodl get sra SRR390728
biodl get ebi ERR164407
biodl get geo GSE13575
biodl status
biodl update
```

## Updates

- **CLI Update**: Run `./biodl update` to check, download, verify SHA-256, and safely upgrade in place without losing downloads or settings.
- **Web UI Update**: Check for updates in the Web UI Settings view and click to update in place, then restart `./biodl start` (or restart your process manager).

## Data And Permissions

- Settings, transfer history, logs, plugins, and proxy configuration are stored under `$HOME/.bio-downloader`.
- Downloads default to `$HOME/Downloads`.
- The service does not require root permissions.
- Files are created as the Linux account that runs `biodl`.

## Security

Binding to `0.0.0.0` exposes the Web UI to reachable networks. Before public release, enable the management authentication controls documented in `AGENT_HANDOFF.md`.

## Speed test and integrity

The Download Center speed-test button opens a browser tab. Both measurements run on the Linux server, not the browser computer. The Axel test counts received network bytes through the same range-checked engine as downloads.

Completed files support individual and queued MD5 checks. Deep automatic MD5 is optional; the default keeps fast size, format and range checks.
