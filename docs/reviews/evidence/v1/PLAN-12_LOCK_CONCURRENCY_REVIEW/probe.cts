const fs=require('node:fs');
const path=require('node:path');
const {syncBuiltinESMExports}=require('node:module');
const role=process.argv[2], prefix=process.argv[3], markers=process.argv[4];
const journal=path.join(prefix,'lib/nexus/.upgrade-journal.json');
const lock=path.join(prefix,'lib/nexus/.upgrade.lock');
const read=fs.readFileSync.bind(fs),unlink=fs.unlinkSync.bind(fs);
const mark=n=>fs.writeFileSync(path.join(markers,n),'1');
function wait(n){const end=Date.now()+5000;while(!fs.existsSync(path.join(markers,n))){if(Date.now()>end)throw Error('barrier timeout '+n);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}
let journals=0,locks=0;
fs.readFileSync=function(p,...args){
 if(String(p)===journal && ++journals===2){
  mark(role+'entered');
  if(role==='A') wait('Bentered');
  else {wait('Afinished');fs.writeFileSync(path.join(markers,'B-observation.json'),JSON.stringify({lockMissingWhileBInRecovery:!fs.existsSync(lock)}));}
  throw Error('controlled probe stops before any package mutation');
 }
 if(String(p)===lock && ++locks===1){const original=read(p,...args);mark(role+'read');if(role==='A')wait('Bread');else wait('Aentered');return original;}
 return read(p,...args);
};
fs.unlinkSync=function(p){if(role==='A' && String(p)===lock && fs.existsSync(lock)){fs.writeFileSync(path.join(markers,'A-unlock-observation.json'),JSON.stringify({myPid:process.pid,removedHolder:JSON.parse(read(lock,'utf8')).pid}));}return unlink(p);};
syncBuiltinESMExports();
(async()=>{const {recoverUpgrade}=await import('./cli/src/upgrade_journal.ts');const result=recoverUpgrade(prefix);fs.writeFileSync(path.join(markers,role+'result.json'),JSON.stringify(result));mark(role+'finished');})().catch(e=>{console.error(e);process.exitCode=1;});
