(function (root) {
  const sources = Object.freeze({
    network: 'https://cdn.npmmirror.com/binaries/node/v20.11.0/node-v20.11.0-darwin-arm64.tar.gz',
    downloader: 'https://sra-pub-run-odp.s3.amazonaws.com/sra/SRR390728/SRR390728'
  });
  if (typeof module === 'object' && module.exports) module.exports = sources;
  else root.SpeedtestSources = sources;
})(typeof globalThis === 'object' ? globalThis : this);
