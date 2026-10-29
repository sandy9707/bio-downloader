// Build an explicit allowlist; private backend, profiles and credentials are never packaged.
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const root = path.resolve(__dirname, '..'), version = require('../package.json').version;
const out = path.join(root, 'dist'), bundle = path.join(out, 'BioDownloader-Linux-x64');
fs.rmSync(bundle, { recursive: true, force: true });fs.mkdirSync(bundle, { recursive: true });
for (const item of ['main.js','renderer.js','preload.js','index.html','speedtest.html','package.json','package-lock.json','THIRD_PARTY_NOTICES.md','packages','shared','img','src/main']) {
  fs.cpSync(path.join(root, item), path.join(bundle,item), {recursive:true});
}
// 2.0.41's updater copies packages/ but not src/. Keep the Linux core inside
// that supported directory, so the FIRST upgrade from 2.0.41 can start safely.
fs.cpSync(path.join(root,'src/main'),path.join(bundle,'packages/core/main'),{recursive:true});
const main = path.join(bundle,'main.js');fs.writeFileSync(main,fs.readFileSync(main,'utf8').replaceAll("require('./src/", "require('./packages/core/"));
fs.cpSync(path.join(root,'bin/linux'),path.join(bundle,'bin/linux'),{recursive:true});
for(const name of ['Country.mmdb','GeoSite.dat'])fs.copyFileSync(path.join(root,'bin',name),path.join(bundle,'bin',name));
fs.mkdirSync(path.join(bundle,'runtime'),{recursive:true});
fs.copyFileSync(process.env.BIODL_NODE_RUNTIME || process.execPath,path.join(bundle,'runtime/node'));
fs.copyFileSync(path.join(root,'packages/cli/biodl'),path.join(bundle,'biodl'));
fs.copyFileSync(path.join(root,'logo.png'),path.join(bundle,'packages/web/logo.png'));
for(const file of ['runtime/node','biodl','bin/linux/axel','bin/linux/mihomo_linux_amd64','bin/linux/aria2/aria2c'])fs.chmodSync(path.join(bundle,file),0o755);

cp.execFileSync('npm',['ci','--omit=dev','--ignore-scripts','--no-audit'],{cwd:bundle,stdio:'inherit'});
cp.execFileSync(path.join(bundle,'runtime/node'),['--version'],{stdio:'inherit'});
cp.execFileSync(path.join(bundle,'bin/linux/axel'),['--version'],{stdio:'inherit'});
cp.execFileSync(path.join(bundle,'bin/linux/aria2/aria2c'),['--version'],{stdio:'inherit'});
const name=`BioDownloader-Linux-x64-${version}.tar.gz`;
cp.execFileSync('tar',['-czf',path.join(out,name),'-C',out,'BioDownloader-Linux-x64']);
const hash=crypto.createHash('sha256').update(fs.readFileSync(path.join(out,name))).digest('hex');
fs.writeFileSync(path.join(out,name+'.sha256'),`${hash}  ${name}\n`);
console.log('LINUX_PACKAGE',JSON.stringify({version,name,sha256:hash,bytes:fs.statSync(path.join(out,name)).size}));
