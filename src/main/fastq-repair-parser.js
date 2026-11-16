'use strict';
// Four-line, unwrapped nucleotide FASTQ diagnostic profile. An invalid profile is
// not proof of corrupt compressed bytes; only source comparison authorizes repair.
class FastqParser {
  constructor({ maxLineBytes = 1024 * 1024, maxUncompressedBytes = Number.MAX_SAFE_INTEGER } = {}) {
    if (![maxLineBytes,maxUncompressedBytes].every(n=>Number.isSafeInteger(n)&&n>0)) throw Error('无效 FASTQ 扫描预算');
    this.maxLineBytes=maxLineBytes; this.maxUncompressedBytes=maxUncompressedBytes;
    this.tail=Buffer.alloc(0); this.line=0; this.records=0; this.sequenceLength=0; this.bytes=0;
  }
  fail(code,message) { throw Object.assign(Error(message),{code,line:this.line+1,records:this.records}); }
  consume(raw) {
    if(raw.length && raw[raw.length-1]===13)raw=raw.subarray(0,-1);
    const phase=this.line%4;
    if(phase===0 && (raw[0]!==64 || raw.length<2))this.fail('FASTQ_STRUCTURE_INVALID','FASTQ read 标题无效');
    if(phase===1) {
      if(!raw.length)this.fail('FASTQ_STRUCTURE_INVALID','空序列不属于当前修复配置');
      if(!/^[ACGTRYSWKMBDHVNacgtryswkmbdhvn]+$/.test(raw.toString('latin1')))this.fail('FASTQ_PROFILE_UNSUPPORTED','序列不符合未折行 IUPAC FASTQ 配置，不能据此断定损坏');
      this.sequenceLength=raw.length;
    }
    if(phase===2 && raw[0]!==43)this.fail('FASTQ_STRUCTURE_INVALID','FASTQ 加号行无效或不是四行格式');
    if(phase===3) {
      if(raw.length!==this.sequenceLength || !/^[!-~]+$/.test(raw.toString('latin1')))this.fail('FASTQ_STRUCTURE_INVALID','FASTQ 质量长度或字符无效');
      this.records++;
    }
    this.line++;
  }
  push(chunk) {
    if(!Buffer.isBuffer(chunk))throw Error('FASTQ 扫描需要字节');
    this.bytes+=chunk.length;
    if(this.bytes>this.maxUncompressedBytes)this.fail('FASTQ_RESOURCE_LIMIT','解压扫描超过字节预算');
    let start=0;
    for(let end=0;end<chunk.length;end++)if(chunk[end]===10) {
      const part=chunk.subarray(start,end);
      if(this.tail.length+part.length>this.maxLineBytes)this.fail('FASTQ_RESOURCE_LIMIT','FASTQ 行超过预算');
      this.consume(this.tail.length?Buffer.concat([this.tail,part]):part);
      this.tail=Buffer.alloc(0);start=end+1;
    }
    const rest=chunk.subarray(start);
    if(this.tail.length+rest.length>this.maxLineBytes)this.fail('FASTQ_RESOURCE_LIMIT','FASTQ 行超过预算');
    if(rest.length)this.tail=Buffer.concat([this.tail,rest]);
  }
  end() {
    if(this.tail.length){this.consume(this.tail);this.tail=Buffer.alloc(0);}
    if(this.line%4 || !this.records)this.fail('FASTQ_STRUCTURE_INVALID','FASTQ 记录未完整结束');
    return {records:this.records,uncompressedBytes:this.bytes};
  }
}
module.exports={FastqParser};
