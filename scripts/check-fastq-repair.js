'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),zlib=require('zlib'),crypto=require('crypto'),assert=require('assert/strict');
const {repairFastqAutomatically}=require('../src/main/fastq-repair-auto');
const {repairSource}=require('../src/main/fastq-repair-policy');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'biodl-fastq-repair-'));
const md5=b=>crypto.createHash('md5').update(b).digest('hex');
// A valid multi-member gzip with one structurally corrupted FASTQ member. This
// is deliberately not presented as arbitrary deflate-bit-error localization.
const text=Buffer.from(('@read\n'+'ACGT'.repeat(100)+'\n+\n'+'I'.repeat(400)+'\n').repeat(40));
const goodMember=zlib.gzipSync(text,{level:0}),badText=Buffer.from(text);badText[0]=33;
const badMember=zlib.gzipSync(badText,{level:0});assert.equal(goodMember.length,badMember.length);
const parts=Array.from({length:200},()=>goodMember),good=Buffer.concat(parts);parts[15]=badMember;const bad=Buffer.concat(parts);
let mode='good',fetched=0;const server=http.createServer((req,res)=>{
 const etag=mode==='weak'?'W/"fixture"':'"fixture"';res.setHeader('ETag',etag);res.setHeader('Content-Length',good.length);
 if(req.method==='HEAD'){res.end();return;}
 const m=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||'');if(!m){res.statusCode=400;res.end();return;}
 assert.equal(req.headers['if-match'],'"fixture"');let a=+m[1],b=+m[2];fetched+=b-a+1;res.statusCode=206;res.setHeader('Content-Length',b-a+1);res.setHeader('Content-Range',`bytes ${mode==='wrong'?a+1:a}-${b}/${good.length}`);if(mode==='change')res.setHeader('ETag','"new"');res.end(good.subarray(a,b+1));
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const sourceUrl=`http://127.0.0.1:${server.address().port}/fixture.fastq.gz`,reference={expectedSize:good.length,expectedMd5:md5(good),gzip:true};
 const filename=path.join(root,'success.fastq.gz');fs.writeFileSync(filename,bad);
 const result=await repairFastqAutomatically({filename,sourceUrl,reference,proxy:false});assert.equal(result.status,'verified');assert.equal(md5(fs.readFileSync(filename)),reference.expectedMd5);assert(result.fetchedBytes<good.length/4);assert.equal(result.patches.length,1);const p=result.patches[0];assert(fs.existsSync(path.join(p.backupPath,'verified.json')));assert(!fs.readFileSync(path.join(p.backupPath,'original.bin')).equals(fs.readFileSync(path.join(p.backupPath,'replacement.bin'))));
 for(const kind of ['wrong','weak','change']){mode=kind;const f=path.join(root,kind+'.gz');fs.writeFileSync(f,bad);await assert.rejects(repairFastqAutomatically({filename:f,sourceUrl,reference,proxy:false}));assert(fs.readFileSync(f).equals(bad));}
 mode='good';const budget=path.join(root,'budget.gz');fs.writeFileSync(budget,bad);await assert.rejects(repairFastqAutomatically({filename:budget,sourceUrl,reference,proxy:false,maxTotalBytes:1024}),/预算/);assert(fs.readFileSync(budget).equals(bad));
 const cancel=new AbortController();cancel.abort();await assert.rejects(repairFastqAutomatically({filename:budget,sourceUrl,reference,proxy:false,signal:cancel.signal}));
 const corrupt=Buffer.from(good);corrupt[100]^=255;const f=path.join(root,'deflate.gz');fs.writeFileSync(f,corrupt);await assert.rejects(repairFastqAutomatically({filename:f,sourceUrl,reference,proxy:false}));
 assert.equal(repairSource({url:sourceUrl},reference,{deep:true}),null);assert.equal(repairSource({url:'https://ftp.sra.ebi.ac.uk/vol1/fastq/SRR123/SRR123456/SRR123456_1.fastq.gz'},reference,{deep:false}),null);
 console.log('FASTQ_REPAIR_OK',JSON.stringify({bytes:good.length,fetchedBytes:result.fetchedBytes,patches:result.patches.length,coverage:'strict Range, strong ETag, changed source, budget, cancel, gzip no guessed offsets, durable original/replacement/final seal'}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close(()=>fs.rmSync(root,{recursive:true,force:true})));
