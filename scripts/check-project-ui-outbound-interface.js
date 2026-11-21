'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
function setup(supported=true){
 const elements=Object.fromEntries(['clashOutboundSettings','clashOutboundInterface','clashOutboundFeedback'].map(id=>[id,{hidden:true,value:'',children:[],replaceChildren(){this.children=[];},appendChild(x){this.children.push(x);}}]));
 let selected='',fail=false;const saved=[];
 const status=()=>({supported,selectedInterface:selected,interfaces:[{name:'Ethernet',index:4,description:'Physical adapter'}],tunDetected:true});
 const context=vm.createContext({document:{getElementById:id=>elements[id],createElement:()=>({})},window:{api:{getClashOutboundInterfaces:async()=>status(),setClashOutboundInterface:async value=>{if(fail)throw Error('interface no longer exists');saved.push(value);selected=value.name;return status();}}}});
 const source=read('renderer.js');const start=source.indexOf('async function loadClashOutboundInterface');assert.ok(start>=0,'outbound UI loader exists');vm.runInContext(source.slice(start,source.indexOf('async function initTransfersAndSettings',start)),context);
 return {context,elements,saved,setFail:()=>{fail=true;}};
}
test('Windows outbound selection defaults auto and saves without restarting tasks',async()=>{const h=setup();await h.context.loadClashOutboundInterface();assert.equal(h.elements.clashOutboundSettings.hidden,false);assert.equal(h.elements.clashOutboundInterface.value,'');assert.equal(h.elements.clashOutboundInterface.children[0].textContent,'自动');h.elements.clashOutboundInterface.value='Ethernet';await h.context.saveClashOutboundInterface();assert.equal(h.saved[0].name,'Ethernet');assert.match(h.elements.clashOutboundFeedback.textContent,/下次启动或优化/);h.setFail();h.elements.clashOutboundInterface.value='missing';await h.context.saveClashOutboundInterface();assert.equal(h.elements.clashOutboundInterface.value,'Ethernet');assert.match(h.elements.clashOutboundFeedback.textContent,/interface no longer exists/);});
test('Non-Windows hides outbound selector',async()=>{const h=setup(false);await h.context.loadClashOutboundInterface();assert.equal(h.elements.clashOutboundSettings.hidden,true);});
test('desktop and Web expose identical outbound IPC contracts',()=>{for(const file of ['preload.js','packages/web/web-bridge.js'])for(const channel of ['clash-get-outbound-interfaces','clash-set-outbound-interface'])assert.ok(read(file).includes(channel));for(const file of ['index.html','packages/web/index.html'])assert.match(read(file),/id="clashOutboundSettings" hidden/);});
