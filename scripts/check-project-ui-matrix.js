'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const root=require('node:path').join(__dirname,'..');
test('table-first shared model: selection does not depend on page or verification',()=>{
 const model=require('../shared/project-view-model');
 const files=Array.from({length:44},(_,i)=>({run:`HRR${Math.floor(i/2)+1}`,name:`read_${i}.fastq.gz`,format:'fastq',url:`https://download.cncb.ac.cn/read_${i}.fastq.gz`}));
 const view=model.create({accession:'HRA1',runs:[],files,pageSize:10},new Map(),()=>null);
 assert.equal(view.rows.length,44); assert.equal(model.selected(view).length,44);
 model.select(view,'none'); view.page=1; assert.equal(model.selected(view).length,0);
 model.select(view,'page'); assert.equal(model.selected(view).length,8);
 view.page=2; assert.equal(model.selected(view).length,8);
 model.select(view,'invert'); assert.equal(model.selected(view).length,16);
 model.select(view,'all');assert.equal(model.selected(view).length,44);
 view.rows[11].checked=false;view.page=1;assert.equal(view.rows[11].checked,false);
});
test('ordinary source matrix preserves different SRA and FASTQ identities',()=>{
 const model=require('../shared/project-view-model');
 const view=model.create({accession:'SRP1',runs:['SRR1'],pageSize:10,files:[{run:'SRR1',name:'SRR1.sra',format:'sra'},{run:'SRR1',name:'SRR1_1.fastq.gz',format:'fastq'}]},new Map(),()=>null);
 assert.equal(view.rows.length,1);assert.deepEqual(view.columns.map(c=>c.id),['cncb','aws','ena']);
 assert.equal(model.columnFor('https://sra-pub-run-odp.s3.amazonaws.com/sra/SRR1/SRR1'),'aws');
 assert.equal(model.columnFor('ftp://ftp.sra.ebi.ac.uk/a.fastq.gz'),'ena');
 assert.deepEqual(view.rows[0].indices,[0,1]);
});
test('SDL supplies a real AWS container without changing the CLI FASTQ manifest',async()=>{
 const {createProjectService}=require('../packages/cli/project-sources');
 const calls=[];const run='SRR123', data=Buffer.from('NCBI.sra-real-container');
 const service=createProjectService(async()=>({accession:'SRP1',access:'public',runs:[run],files:[{run,name:run+'_1.fastq.gz',format:'fastq',url:'https://ftp.sra.ebi.ac.uk/vol1/fastq/'+run+'/'+run+'_1.fastq.gz'}]}),{get:async(url)=>{
 calls.push(url);
 if(url.startsWith('https://locate.ncbi'))return {data:{result:[{bundle:run,status:200,files:[{accession:run,type:'sra',size:data.length,locations:[{link:`https://sra-pub-run-odp.s3.amazonaws.com/sra/${run}/${run}`}]}]}]}};
 if(url.includes('s3.amazonaws.com'))return {status:206,headers:{'content-range':`bytes 0-${data.length-1}/${data.length}`,'content-length':String(data.length)},data};
 throw Error('Unexpected request '+url);
 }});
 const result=await service.query('SRP1');assert.equal(calls.length,0,'render manifest before any source discovery');
 assert.equal(result.files.length,1);assert.equal(result.matrixFiles.length,2);
 const rows=await service.probe({queryId:result.queryId,page:{indices:[1],column:'aws'}});
 assert.equal(rows[0].sources[0].available,true);assert.equal(rows[0].file.format,'sra');assert.equal(rows[0].file.size,data.length);
 assert.equal(rows[0].sources[0].url,`https://sra-pub-run-odp.s3.amazonaws.com/sra/${run}/${run}`);
 assert.equal(calls.length,2);
});

test('a Run column adopts complete mates only and never blocks FASTQ on SRA metadata',()=>{
 const M=require('../shared/project-view-model');
 const view=M.create({accession:'SRP1',runs:['SRR1'],files:[{run:'SRR1',name:'r1',format:'fastq'},{run:'SRR1',name:'r2',format:'fastq'},{run:'SRR1',name:'sra',format:'sra'}]},new Map(),()=>null);
 const choice=item=>({source:item.file.name==='r1'?{}:null});
 assert.equal(M.columnItems(view,view.rows[0],'ena',choice).length,0);
 assert.equal(M.columnItems(view,view.rows[0],'ena',item=>({source:item.file.format==='fastq'?{}:null})).length,2);
 assert.equal(M.columnItems(view,view.rows[0],'aws',item=>({source:item.file.format==='sra'?{}:null})).length,1);
});

test('cancel aborts HTTP and stops subsequent source batches',async()=>{
 const {createProjectService}=require('../packages/cli/project-sources');let started=0;
 const files=Array.from({length:8},(_,i)=>({run:'HRR'+i,name:`f${i}.fastq.gz`,format:'fastq',url:`https://download.cncb.ac.cn/f${i}.fastq.gz`}));
 const service=createProjectService(async()=>({accession:'HRA1',access:'public',runs:files.map(f=>f.run),files}),{get:async(url,{signal})=>{started++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));}});
 const result=await service.query('HRA1');
 const pending=service.probe({queryId:result.queryId,page:{indices:files.map((_,i)=>i),column:'https'}});
 await service.probe({queryId:result.queryId,page:{cancel:true}});
 await assert.rejects(pending);assert.equal(started,1,'only the initial serial HRA worker started');
});

test('desktop and Web load shared table renderer and have whole-project selection controls',()=>{
 for(const name of ['index.html','packages/web/index.html']){
 const html=fs.readFileSync(require('node:path').join(root,name),'utf8');
 assert.match(html,/shared\/project-view-model.js/);assert.match(html,/shared\/project-view-table.js/);
 for(const mode of ['all','page','invert','none'])assert.ok(html.includes(`selectProjectRows('${mode}')`));
 }
});
