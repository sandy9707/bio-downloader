const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const s=fs.readFileSync(require('path').join(__dirname,'../main.js'),'utf8');
const c=vm.createContext({});vm.runInContext(s.slice(s.indexOf('function compareVersions('),s.indexOf('// 判断 URL 是否')),c);
for(const [a,b,result] of [['2.2.4','2.2.3',1],['2.2.3','2.2.3-preview.11',1],['2.2.3-preview.11','2.2.3-preview.9',1],['2.2.4','2.2.4',0],['2.2.4-preview.1','2.2.4',-1]])assert.equal(c.compareVersions(a,b),result);
console.log('VERSION_ORDER_OK');
