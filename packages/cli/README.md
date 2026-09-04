# BioDownloader Linux

## Recommended: Web UI

```bash
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
biodl get sra SRR390728
biodl get ebi ERR164407
biodl get geo GSE13575
biodl status
```

## Data And Permissions

- Settings, transfer history, logs, plugins, and proxy configuration are stored under `$HOME/.bio-downloader`.
- Downloads default to `$HOME/Downloads`.
- The service does not require root permissions.
- Files are created as the Linux account that runs `biodl`.

## Security

Binding to `0.0.0.0` exposes the Web UI to reachable networks. Before public release, enable the management authentication controls documented in `AGENT_HANDOFF.md`.
