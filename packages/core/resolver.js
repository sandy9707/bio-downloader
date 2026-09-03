const axios = require('axios');
const cheerio = require('cheerio');

const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL || 'https://biodown.ye.aimeals.cn';

async function headRequestSize(url, proxyPort = 43289) {
  if (!url || typeof url !== 'string') return 0;
  
  // NCBI / EBI 映射 https
  let targetUrl = url;
  if (targetUrl.startsWith('ftp://ftp.ncbi.nlm.nih.gov/') || targetUrl.startsWith('ftps://ftp.ncbi.nlm.nih.gov/')) {
    targetUrl = targetUrl.replace(/^ftps?:\/\/ftp\.ncbi\.nlm\.nih\.gov\//, 'https://ftp.ncbi.nlm.nih.gov/');
  } else if (targetUrl.startsWith('ftp://ftp.sra.ebi.ac.uk/') || targetUrl.startsWith('ftps://ftp.sra.ebi.ac.uk/')) {
    targetUrl = targetUrl.replace(/^ftps?:\/\/ftp\.sra\.ebi\.ac\.uk\//, 'https://ftp.sra.ebi.ac.uk/');
  }

  const directOptions = { timeout: 10000, maxRedirects: 5 };
  const proxyOptions = proxyPort ? {
    timeout: 12000,
    maxRedirects: 5,
    proxy: { protocol: 'http', host: '127.0.0.1', port: proxyPort }
  } : null;

  const tryGetSize = (headers) => {
    if (!headers) return 0;
    if (headers['content-range']) {
      const match = headers['content-range'].match(/\/(\d+)$/);
      if (match && parseInt(match[1], 10) > 0) return parseInt(match[1], 10);
    }
    if (headers['content-length']) {
      const len = parseInt(headers['content-length'], 10);
      if (!isNaN(len) && len > 0) return len;
    }
    return 0;
  };

  // 1. 直连 HEAD
  try {
    const res = await axios.head(targetUrl, directOptions);
    const size = tryGetSize(res.headers);
    if (size > 0) return size;
  } catch (e) {}

  // 2. 代理 HEAD
  if (proxyOptions) {
    try {
      const res = await axios.head(targetUrl, proxyOptions);
      const size = tryGetSize(res.headers);
      if (size > 0) return size;
    } catch (e) {}
  }

  // 3. Range 探测 (GET 0-1)
  try {
    const res = await axios.get(targetUrl, { ...directOptions, headers: { Range: 'bytes=0-1' }, validateStatus: () => true });
    const size = tryGetSize(res.headers);
    if (size > 0) return size;
  } catch (e) {}

  if (proxyOptions) {
    try {
      const res = await axios.get(targetUrl, { ...proxyOptions, headers: { Range: 'bytes=0-1' }, validateStatus: () => true });
      const size = tryGetSize(res.headers);
      if (size > 0) return size;
    } catch (e) {}
  }

  return 0;
}

async function resolveSources(type, inputVal, proxyPort = 43289) {
  const ids = inputVal.split(/[\s,\n;]+/).map(x => x.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error('请输入正确的编号或链接');

  const files = [];

  if (type === 'sra_raw') {
    const promises = ids.map(async (acc) => {
      const url = `https://sra-pub-run-odp.s3.amazonaws.com/sra/${acc}/${acc}`;
      const size = await headRequestSize(url, proxyPort);
      return { name: acc, url, size, type: 'sra_raw' };
    });
    const results = await Promise.all(promises);
    files.push(...results);
  } else if (type === 'ebi_raw' || type === 'ena_raw') {
    const promises = ids.map(async (acc) => {
      try {
        const enaUrl = `https://www.ebi.ac.uk/ena/portal/api/filereport?accession=${acc}&result=read_run&fields=fastq_ftp&format=json`;
        let res;
        try {
          res = await axios.get(enaUrl, {
            timeout: 15000,
            proxy: proxyPort ? { protocol: 'http', host: '127.0.0.1', port: proxyPort } : false
          });
        } catch (err) {
          res = await axios.get(enaUrl, { timeout: 10000 });
        }
        if (res.data && res.data[0] && res.data[0].fastq_ftp) {
          const urls = res.data[0].fastq_ftp.split(';');
          const subPromises = urls.map(async (u) => {
            const cleanUrl = u.startsWith('http') ? u : 'https://' + u;
            const size = await headRequestSize(cleanUrl, proxyPort);
            const fname = cleanUrl.substring(cleanUrl.lastIndexOf('/') + 1);
            return { name: fname, url: cleanUrl, size, folder: acc, type: 'ebi_raw' };
          });
          return await Promise.all(subPromises);
        } else {
          const url = `https://sra-pub-run-odp.s3.amazonaws.com/sra/${acc}/${acc}`;
          const size = await headRequestSize(url, proxyPort);
          return [{ name: acc, url, size, type: 'sra_raw' }];
        }
      } catch (e) {
        const url = `https://sra-pub-run-odp.s3.amazonaws.com/sra/${acc}/${acc}`;
        const size = await headRequestSize(url, proxyPort);
        return [{ name: acc, url, size, type: 'sra_raw' }];
      }
    });
    const results = await Promise.all(promises);
    results.forEach(subList => files.push(...subList));
  } else if (type === 'geo_suppl') {
    for (const acc of ids) {
      try {
        const match = acc.match(/(\d+)/);
        if (!match) continue;
        const num = parseInt(match[1], 10);
        let stub = 'GSE' + String(num).padStart(3, '0');
        if (num >= 1000) stub = 'GSE' + String(num).slice(0, -3) + 'nnn';
        const geoUrl = `https://ftp.ncbi.nlm.nih.gov/geo/series/${stub}/${acc}/suppl/`;
        let res;
        try {
          res = await axios.get(geoUrl, {
            timeout: 15000,
            proxy: proxyPort ? { protocol: 'http', host: '127.0.0.1', port: proxyPort } : false
          });
        } catch (err) {
          res = await axios.get(geoUrl, { timeout: 10000 });
        }
        const $ = cheerio.load(res.data);
        const links = [];
        $('a').each((_, el) => {
          const href = $(el).attr('href');
          if (href && !href.startsWith('?') && !href.startsWith('/') && href !== '../') {
            links.push(href);
          }
        });
        for (const l of links) {
          const fullUrl = geoUrl.endsWith('/') ? geoUrl + l : geoUrl + '/' + l;
          const size = await headRequestSize(fullUrl, proxyPort);
          files.push({ name: l, url: fullUrl, size, folder: acc, type: 'geo_suppl' });
        }
      } catch (err) {
        console.warn(`Failed to parse GEO suppl ${acc}:`, err.message);
      }
    }
  } else {
    // 直链、Zenodo、HF、FTP、SFTP
    const promises = ids.map(async (url) => {
      const size = await headRequestSize(url, proxyPort);
      let name = url.split('?')[0].split('#')[0].split('/').pop() || `download_${Date.now()}`;
      return { name, url, size, type: type || 'direct' };
    });
    const results = await Promise.all(promises);
    files.push(...results);
  }

  return files;
}

module.exports = {
  BACKEND_BASE_URL,
  headRequestSize,
  resolveSources
};
