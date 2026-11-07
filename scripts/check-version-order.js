const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const s=fs.readFileSync(require('path').join(__dirname,'../main.js'),'utf8');
const c=vm.createContext({});vm.runInContext(s.slice(s.indexOf('function compareVersions('),s.indexOf('// 判断 URL 是否')),c);
for(const [a,b,result] of [['2.2.4','2.2.3',1],['2.2.3','2.2.3-preview.11',1],['2.2.3-preview.11','2.2.3-preview.9',1],['2.2.4','2.2.4',0],['2.2.4-preview.1','2.2.4',-1]])assert.equal(c.compareVersions(a,b),result);
// Both current semver and legacy numeric preview clients must see this stable
// release as newer. Stable and P2 manifests are published together.
function legacyCompare(a,b) {
  const left=a.split('.').map(n=>parseInt(n,10)||0),right=b.split('.').map(n=>parseInt(n,10)||0);
  for(let i=0;i<Math.max(left.length,right.length);i++) {
    const delta=(left[i]||0)-(right[i]||0);if(delta)return Math.sign(delta);
  }
  return 0;
}
for(const previous of ['2.2.7','2.2.8-preview.1','2.2.6-preview.1','2.2.3-preview.11']) {
  assert.equal(c.compareVersions('2.2.9',previous),1);
  assert.equal(legacyCompare('2.2.9',previous),1);
}
console.log('VERSION_ORDER_OK');
