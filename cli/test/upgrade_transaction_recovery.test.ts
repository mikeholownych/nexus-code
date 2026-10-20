import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { CURRENT_STATE_SCHEMA_VERSION } from "../src/core/state.js";
import { verifyInstalledRuntime } from "../src/upgrade_health.js";
import { writeJournal, readJournal, recoverUpgrade, createPreMigrationBackup, restoreConfigBackup, acquireReclaimGuard, UpgradeJournalEntry, RecoveryOutcome } from "../src/upgrade_journal.js";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { generateCompatibilityMetadata } from "../src/compatibility.js";
import { performUpgrade, compareInstallationWithRelease, parseSemver, rollbackBinary } from "../src/upgrade.js";
import { withStateStoreGuard } from "../src/core/state_store_guard.js";
import { hasPendingStateRestore, recoverPendingStateRestore, restoreFromSources } from "../src/core/state_restore.js";

function runtime(root:string, version:string, marker="original"):void {
  for (const dir of ["bin", "lib/core", "lib/cli/dist"]) fs.mkdirSync(path.join(root,dir),{recursive:true});
  fs.writeFileSync(path.join(root,"VERSION"),version);
  fs.writeFileSync(path.join(root,"marker"),marker);
  fs.writeFileSync(path.join(root,"lib/cli/dist/index.js"),"// fixture payload\n");
  fs.writeFileSync(path.join(root,"bin/nexus"),`#!/bin/sh\necho ${version}\n`,{mode:0o755});
  fs.writeFileSync(path.join(root,"lib/core/harness-core"),`#!/bin/sh\necho ${version}\n`,{mode:0o755});
  fs.writeFileSync(path.join(root,"lib/core/nexus-tui"),`#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; else echo NEXUS; fi\n`,{mode:0o755});
}
describe("durable same-version transaction recovery",()=>{
  let prefix:string,entry:UpgradeJournalEntry;
  beforeEach(()=>{
    prefix=fs.mkdtempSync(path.join(os.tmpdir(),"nexus-transaction-"));
    const root=path.join(prefix,"lib/nexus/v1.0.0");runtime(root,"v1.0.0");
    fs.mkdirSync(path.join(prefix,"bin"));fs.symlinkSync(path.join(root,"bin/nexus"),path.join(prefix,"bin/nexus"));
    const id="fixture-transaction";
    entry={formatVersion:1,id,state:"switching",sourceVersion:"v1.0.0",targetVersion:"v1.0.0",sourceInstallDir:root,targetInstallDir:root,sourceSymlinkTarget:path.join(root,"bin/nexus"),binPath:path.join(prefix,"bin/nexus"),prefix,startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),replacementBackupDir:path.join(prefix,"lib/nexus",`.rollback-${id}`),displacedTargetDir:path.join(prefix,"lib/nexus",`.failed-${id}`),stagingDir:path.join(prefix,"lib/nexus",`.tmp-upgrade-${id}`)};
    fs.mkdirSync(entry.stagingDir!);fs.writeFileSync(path.join(entry.stagingDir!,"canary"),"keep until safe");
  });
  afterEach(()=>fs.rmSync(prefix,{recursive:true,force:true}));
  for(const window of ["before-old-move","after-old-move","after-new-move","after-provenance","after-link","after-failed-displacement"]){
    it(`preserves the only working package after crash ${window}`,()=>{
      if(window!=="before-old-move") fs.renameSync(entry.sourceInstallDir,entry.replacementBackupDir!);
      if(["after-new-move","after-provenance","after-link","after-failed-displacement"].includes(window)){
        runtime(entry.targetInstallDir,"v1.0.0","replacement");
        fs.writeFileSync(path.join(entry.targetInstallDir,"bin/nexus"),"#!/bin/sh\nexit 1\n",{mode:0o755});
      }
      if(window==="after-provenance") fs.writeFileSync(path.join(entry.targetInstallDir,".provenance.json"),"partial");
      if(window==="after-link") entry.state="switched";
      if(window==="after-failed-displacement") fs.renameSync(entry.targetInstallDir,entry.displacedTargetDir!);
      writeJournal(prefix,entry);
      const result=recoverUpgrade(prefix);
      assert.equal(result.recovered,true,result.details);
      assert.equal(fs.readFileSync(path.join(entry.sourceInstallDir,"marker"),"utf8"),"original");
      assert.equal(verifyInstalledRuntime(entry.sourceInstallDir,"v1.0.0").healthy,true);
      assert.equal(readJournal(prefix)?.state,"rolled_back");
      assert.equal(recoverUpgrade(prefix).action,"none");
    });
  }
  it("retains backups and truthful journal when restoring the link fails",()=>{
    fs.renameSync(entry.sourceInstallDir,entry.replacementBackupDir!);
    runtime(entry.targetInstallDir,"v1.0.0","replacement");
    fs.unlinkSync(entry.binPath);fs.mkdirSync(entry.binPath);writeJournal(prefix,entry);
    const result=recoverUpgrade(prefix);
    assert.equal(result.action,"manual_intervention");
    assert.equal(readJournal(prefix)?.state,"recovery_required");
    assert.equal(fs.readFileSync(path.join(entry.sourceInstallDir,"marker"),"utf8"),"original");
    assert.ok(fs.existsSync(entry.stagingDir!));
    assert.ok(fs.existsSync(entry.displacedTargetDir!));
  });
  it("admits only one recovery when two contenders both observe the same stale lock",async()=>{
    writeJournal(prefix,entry);
    const libRoot=path.join(prefix,"lib/nexus"), barrier=path.join(prefix,"barrier");
    fs.mkdirSync(barrier);fs.writeFileSync(path.join(libRoot,".upgrade.lock"),JSON.stringify({pid:999999,token:"dead"}),{mode:0o600});
    // The kernel guard is permanent: simulate a guard left behind by any prior
    // run (including a crashed reclaimer) so both contenders race on the flock.
    fs.writeFileSync(path.join(libRoot,".upgrade.lock.guard"),"",{mode:0o600});
    const cwd=path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),"..");
    const children=[1,2].map(id=>{
      const code=`import * as fs from 'node:fs'; import * as path from 'node:path'; import { recoverUpgrade } from './src/upgrade_journal.ts'; const b=${JSON.stringify(barrier)}; const p=${JSON.stringify(prefix)}; const id=${id}; const result=recoverUpgrade(p,{onStaleLockObserved(){fs.writeFileSync(path.join(b,'ready-'+id),'ready'); const end=Date.now()+5000; while(Date.now()<end && (!fs.existsSync(path.join(b,'ready-1')) || !fs.existsSync(path.join(b,'ready-2')))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); if(!fs.existsSync(path.join(b,'ready-1')) || !fs.existsSync(path.join(b,'ready-2'))) throw new Error('barrier timed out'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150); }}); console.log(JSON.stringify(result));`;
      const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",code],{cwd,env:{...process.env,HOME:prefix},stdio:["ignore","pipe","pipe"]});
      let out="",err="";child.stdout.on("data",d=>out+=d);child.stderr.on("data",d=>err+=d);
      return new Promise<RecoveryOutcome>((resolve,reject)=>{child.on("error",reject);child.on("exit",code=>{if(code!==0)return reject(new Error(err));try{resolve(JSON.parse(out.trim()));}catch(e){reject(new Error(`${err}${out}`));}});});
    });
    const results=await Promise.all(children);
    assert.equal(results.filter(r=>r.recovered && r.action==="rolled_back").length,1,JSON.stringify(results));
    assert.equal(results.filter(r=>!r.recovered && r.action==="upgrade_in_progress").length,1,JSON.stringify(results));
    assert.equal(fs.existsSync(path.join(libRoot,".upgrade.lock")),false);
    assert.equal(fs.existsSync(path.join(libRoot,".upgrade.lock.guard")),true);
    assert.equal(fs.readFileSync(path.join(entry.sourceInstallDir,"marker"),"utf8"),"original");
    assert.equal(verifyInstalledRuntime(entry.sourceInstallDir,"v1.0.0").healthy,true);
    assert.equal(readJournal(prefix)?.state,"rolled_back");
  });
  it("reclaims a stale lock through the kernel guard without contention",()=>{
    writeJournal(prefix,entry);
    const libRoot=path.join(prefix,"lib/nexus");
    fs.writeFileSync(path.join(libRoot,".upgrade.lock"),JSON.stringify({pid:999999,token:"dead"}),{mode:0o600});
    const result=recoverUpgrade(prefix);
    assert.equal(result.recovered,true,result.details);
    assert.equal(result.action,"rolled_back");
    assert.equal(fs.existsSync(path.join(libRoot,".upgrade.lock")),false);
    assert.equal(fs.existsSync(path.join(libRoot,".upgrade.lock.guard")),true);
    assert.equal(readJournal(prefix)?.state,"rolled_back");
  });
  it("reports the guard path and stays back while a live reclaimer holds the kernel guard",async()=>{
    writeJournal(prefix,entry);
    const libRoot=path.join(prefix,"lib/nexus");
    fs.writeFileSync(path.join(libRoot,".upgrade.lock"),JSON.stringify({pid:999999,token:"dead"}),{mode:0o600});
    const guardPath=path.join(libRoot,".upgrade.lock.guard"), held=path.join(prefix,"guard-held");
    fs.writeFileSync(guardPath,"",{mode:0o600});
    const cwd=path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),"..");
    const code=`import * as fs from 'node:fs'; import { spawnSync } from 'node:child_process'; const g=${JSON.stringify(guardPath)}; const m=${JSON.stringify(held)}; const fd=fs.openSync(g,'r+'); const r=spawnSync('/usr/bin/flock',['-n','-E','75','3'],{stdio:['ignore','ignore','ignore',fd]}); if(r.status!==0){process.exit(3);} fs.writeFileSync(m,'held'); setInterval(()=>{},1000);`;
    const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",code],{cwd,env:{...process.env,HOME:prefix},stdio:["ignore","ignore","pipe"]});
    const failTimer=setTimeout(()=>child.kill("SIGKILL"),10000);
    try {
      const end=Date.now()+5000;
      while(Date.now()<end && !fs.existsSync(held)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
      assert.equal(fs.existsSync(held),true,"guard holder did not start");
      const result=recoverUpgrade(prefix);
      assert.equal(result.action,"upgrade_in_progress");
      assert.ok(result.details.includes(".upgrade.lock.guard"),result.details);
      assert.equal(fs.existsSync(path.join(libRoot,".upgrade.lock")),true);
      assert.equal(readJournal(prefix)?.state,"switching");
    } finally { clearTimeout(failTimer); child.kill("SIGKILL"); await new Promise<void>(r=>child.on("exit",()=>r())); }
  });
  it("acquires the kernel guard after its holder is killed",async()=>{
    writeJournal(prefix,entry);
    const libRoot=path.join(prefix,"lib/nexus");
    fs.writeFileSync(path.join(libRoot,".upgrade.lock"),JSON.stringify({pid:999999,token:"dead"}),{mode:0o600});
    const guardPath=path.join(libRoot,".upgrade.lock.guard"), held=path.join(prefix,"guard-held-2");
    fs.writeFileSync(guardPath,"",{mode:0o600});
    const cwd=path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),"..");
    const code=`import * as fs from 'node:fs'; import { spawnSync } from 'node:child_process'; const g=${JSON.stringify(guardPath)}; const m=${JSON.stringify(held)}; const fd=fs.openSync(g,'r+'); const r=spawnSync('/usr/bin/flock',['-n','-E','75','3'],{stdio:['ignore','ignore','ignore',fd]}); if(r.status!==0){process.exit(3);} fs.writeFileSync(m,'held'); setInterval(()=>{},1000);`;
    const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",code],{cwd,env:{...process.env,HOME:prefix},stdio:["ignore","ignore","pipe"]});
    try {
      const end=Date.now()+5000;
      while(Date.now()<end && !fs.existsSync(held)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
      assert.equal(fs.existsSync(held),true,"guard holder did not start");
      child.kill("SIGKILL");
      await new Promise<void>(r=>child.on("exit",()=>r()));
      const result=recoverUpgrade(prefix);
      assert.equal(result.recovered,true,result.details);
      assert.equal(result.action,"rolled_back");
      assert.equal(fs.existsSync(path.join(libRoot,".upgrade.lock")),false);
      assert.equal(fs.existsSync(guardPath),true);
      assert.equal(readJournal(prefix)?.state,"rolled_back");
    } finally { child.kill("SIGKILL"); }
  });
  it("does not leak descriptors across repeated guard contention",async()=>{
    const libRoot=path.join(prefix,"lib/nexus");
    const guardPath=path.join(libRoot,".upgrade.lock.guard"), held=path.join(prefix,"guard-held-3");
    fs.writeFileSync(guardPath,"",{mode:0o600});
    const cwd=path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),"..");
    const code=`import * as fs from 'node:fs'; import { spawnSync } from 'node:child_process'; const g=${JSON.stringify(guardPath)}; const m=${JSON.stringify(held)}; const fd=fs.openSync(g,'r+'); const r=spawnSync('/usr/bin/flock',['-n','-E','75','3'],{stdio:['ignore','ignore','ignore',fd]}); if(r.status!==0){process.exit(3);} fs.writeFileSync(m,'held'); setInterval(()=>{},1000);`;
    const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",code],{cwd,env:{...process.env,HOME:prefix},stdio:["ignore","ignore","pipe"]});
    const failTimer=setTimeout(()=>child.kill("SIGKILL"),10000);
    try {
      const end=Date.now()+5000;
      while(Date.now()<end && !fs.existsSync(held)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
      assert.equal(fs.existsSync(held),true,"guard holder did not start");
      const count=()=>fs.readdirSync("/proc/self/fd").length;
      const before=count();
      for(let i=0;i<10;i++) assert.equal(acquireReclaimGuard(guardPath),null);
      assert.equal(count(),before,`descriptor count changed ${before} -> ${count()}`);
    } finally { clearTimeout(failTimer); child.kill("SIGKILL"); await new Promise<void>(r=>child.on("exit",()=>r())); }
  });
  it("fails closed when the flock utility is unavailable",()=>{
    const guardPath=path.join(prefix,"lib/nexus",".upgrade.lock.guard");
    fs.writeFileSync(guardPath,"",{mode:0o600});
    assert.throws(()=>acquireReclaimGuard(guardPath,"/nonexistent/nexus-flock-probe"),/unavailable/i);
  });
  it("rejects a symlinked reclaim guard",()=>{
    const guardPath=path.join(prefix,"lib/nexus",".upgrade.lock.guard");
    const target=path.join(prefix,"guard-target");
    fs.writeFileSync(target,"",{mode:0o600});
    fs.symlinkSync(target,guardPath);
    assert.throws(()=>acquireReclaimGuard(guardPath),/redirected|regular file/);
  });
  it("rejects a FIFO reclaim guard",()=>{
    const guardPath=path.join(prefix,"lib/nexus",".upgrade.lock.guard");
    const made=spawnSync("mkfifo",[guardPath]);
    assert.equal(made.error,undefined,String(made.error));
    assert.throws(()=>acquireReclaimGuard(guardPath),/redirected|regular file/);
  });
  it("rejects a reclaim guard with unsafe permissions",()=>{
    const guardPath=path.join(prefix,"lib/nexus",".upgrade.lock.guard");
    fs.writeFileSync(guardPath,"",{mode:0o600});
    fs.chmodSync(guardPath,0o644);
    assert.throws(()=>acquireReclaimGuard(guardPath),/unsafe permissions/);
  });
  it("does not touch the lock for a completed journal in a read-only package directory",()=>{
    entry.state="complete";writeJournal(prefix,entry);
    const libRoot=path.join(prefix,"lib/nexus");
    fs.chmodSync(libRoot,0o555);
    try {
      assert.deepEqual(recoverUpgrade(prefix),{recovered:false,action:"none",details:"No interrupted upgrade found in journal."});
      assert.equal(fs.existsSync(path.join(libRoot,".upgrade.lock")),false);
      const result=spawnSync(process.execPath,["--import","tsx","src/index.ts","models","--help"],{
        cwd:path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),".."),encoding:"utf8",timeout:10000,
        env:{...process.env,HOME:prefix,XDG_CONFIG_HOME:path.join(prefix,".config"),NEXUS_HOME:entry.sourceInstallDir},
      });
      assert.equal(result.error,undefined,String(result.error));
      assert.notEqual(result.status,2,result.stderr+result.stdout);
      assert.equal(fs.existsSync(path.join(libRoot,".upgrade.lock")),false);
    } finally { fs.chmodSync(libRoot,0o755); }
  });
  it("does not finalize a launcher that reports the wrong release",()=>{
    fs.renameSync(entry.sourceInstallDir,entry.replacementBackupDir!);runtime(entry.targetInstallDir,"v1.0.0","replacement");
    fs.writeFileSync(path.join(entry.targetInstallDir,"bin/nexus"),"#!/bin/sh\necho v9.9.9\n",{mode:0o755});
    entry.state="verified";writeJournal(prefix,entry);
    assert.equal(recoverUpgrade(prefix).action,"rolled_back");
    assert.equal(fs.readFileSync(path.join(entry.sourceInstallDir,"marker"),"utf8"),"original");
  });
  it("refuses missing runtime components despite a successful version shim",()=>{
    fs.rmSync(path.join(entry.sourceInstallDir,"lib/core/nexus-tui"));
    assert.equal(verifyInstalledRuntime(entry.sourceInstallDir,"v1.0.0").healthy,false);
    writeJournal(prefix,entry);assert.equal(recoverUpgrade(prefix).action,"manual_intervention");
  });
  it("uses the actual previous same-version package for explicit binary rollback",()=>{
    fs.renameSync(entry.sourceInstallDir,entry.replacementBackupDir!);runtime(entry.targetInstallDir,"v1.0.0","replacement");
    entry.state="complete";writeJournal(prefix,entry);
    assert.equal(rollbackBinary(prefix).success,true);
    assert.equal(fs.readFileSync(path.join(entry.sourceInstallDir,"marker"),"utf8"),"original");
  });
  it("rejects a redirected backup without touching outside data",()=>{
    const external=path.join(prefix,"external");runtime(external,"v1.0.0");fs.symlinkSync(external,entry.replacementBackupDir!);
    writeJournal(prefix,entry);assert.equal(recoverUpgrade(prefix).action,"manual_intervention");
    assert.equal(fs.readFileSync(path.join(external,"marker"),"utf8"),"original");
  });
  it("check-only leaves a pending transaction byte-for-byte unchanged",()=>{
    writeJournal(prefix,entry);
    const journalPath=path.join(prefix,"lib/nexus/.upgrade-journal.json"), before=fs.readFileSync(journalPath,"utf8");
    const result=spawnSync(process.execPath,["--import","tsx","src/index.ts","upgrade","--check","--json","--timeout","50","--prefix",prefix],{
      cwd:path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),".."), encoding:"utf8",timeout:10000,
      env:{...process.env,HOME:prefix,XDG_CONFIG_HOME:path.join(prefix,".config"),NEXUS_HOME:entry.sourceInstallDir,NEXUS_RELEASES_API:"http://127.0.0.1:1/releases"},
    });
    assert.equal(result.error,undefined,String(result.error));
    assert.equal(fs.readFileSync(journalPath,"utf8"),before);
    assert.ok(fs.existsSync(path.join(entry.stagingDir!,"canary")));
  });
  it("explicit recovery rejects invalid journals with an operational exit",()=>{
    writeJournal(prefix,{...entry,sourceInstallDir:path.join(prefix,"outside")});
    const result=spawnSync(process.execPath,["--import","tsx","src/index.ts","upgrade","--recover","--json","--prefix",prefix],{
      cwd:path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),".."),encoding:"utf8",timeout:10000,
      env:{...process.env,HOME:prefix,XDG_CONFIG_HOME:path.join(prefix,".config"),NEXUS_HOME:entry.sourceInstallDir},
    });
    assert.equal(result.status,2,result.stderr+result.stdout);
    assert.equal(JSON.parse(result.stdout).status,"error");
  });
  it("bounds hung probes and kills their process group",()=>{
    const childPid=path.join(prefix,"child.pid");
    fs.writeFileSync(path.join(entry.sourceInstallDir,"bin/nexus"),`#!/bin/sh\nsleep 60 &\necho $! > '${childPid}'\nwait\n`,{mode:0o755});
    const start=Date.now();assert.equal(verifyInstalledRuntime(entry.sourceInstallDir,"v1.0.0",150).healthy,false);
    assert.ok(Date.now()-start<4000);
    const pid=Number(fs.readFileSync(childPid,"utf8"));
    // A reparented zombie is dead; it must not remain a running sleep process.
    const stat=spawnSync("ps",["-o","stat=","-p",String(pid)],{encoding:"utf8"});
    assert.ok(!stat.stdout.trim() || stat.stdout.trim().startsWith("Z"),stat.stdout);
  });
});
describe("complete private state/config backup restore",()=>{
 it("restores session payloads and config rather than copying an archive into config.env",()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"nexus-backup-roundtrip-"));
  try{
    fs.mkdirSync(path.join(home,".nexus/sessions/a"),{recursive:true,mode:0o700});fs.mkdirSync(path.join(home,".config/nexus"),{recursive:true,mode:0o700});
    fs.chmodSync(path.join(home,".nexus"),0o700);fs.chmodSync(path.join(home,".nexus/sessions"),0o700);fs.chmodSync(path.join(home,".nexus/sessions/a"),0o700);
    fs.chmodSync(path.join(home,".config/nexus"),0o700);
    const session=path.join(home,".nexus/sessions/a/events.jsonl"), config=path.join(home,".config/nexus/config.env");
    fs.writeFileSync(session,"original session");fs.writeFileSync(config,"MODEL=original\n");
    const backup=createPreMigrationBackup(home);fs.writeFileSync(session,"modified session");fs.writeFileSync(config,"MODEL=modified\n");
    fs.writeFileSync(path.join(home,".nexus/sessions/new-after-backup"),"new");
    assert.equal(restoreConfigBackup(backup.stateBackupDir!,home),true);
    assert.equal(fs.existsSync(path.join(home,".nexus/sessions/new-after-backup")),false);
    assert.equal(fs.readFileSync(session,"utf8"),"original session");assert.equal(fs.readFileSync(config,"utf8"),"MODEL=original\n");
    const secondBackup=createPreMigrationBackup(home);
    fs.writeFileSync(session,"changed again");
    const orphan=path.join(home,".nexus/restore-control/transactions/8a6f250c-6a13-4a8a-83c4-303c7eb9bd53");
    fs.mkdirSync(orphan,{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(orphan,"interrupted-stage"),"private orphan",{mode:0o600});
    assert.equal(restoreConfigBackup(secondBackup.stateBackupDir!,home),true);
    assert.equal(fs.readFileSync(session,"utf8"),"original session");
    assert.equal(fs.existsSync(orphan),false);
    const archive=path.join(home,"backup.tar.gz");fs.writeFileSync(archive,Buffer.from([0x1f,0x8b,0x08]));
    assert.equal(restoreConfigBackup(archive,home),false);assert.equal(fs.readFileSync(config,"utf8"),"MODEL=original\n");
  }finally{fs.rmSync(home,{recursive:true,force:true});}
 });

 it("flushes every automatic backup payload and containing directory before returning",()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"nexus-backup-fsync-"));
  const originalFsync=fsDefault.fsyncSync;
  const flushed=new Set<string>();
  try{
   const sessionDir=path.join(home,".nexus/sessions/a");
   const configDir=path.join(home,".config/nexus");
   fs.mkdirSync(sessionDir,{recursive:true,mode:0o700});
   fs.mkdirSync(configDir,{recursive:true,mode:0o700});
   for(const directory of [path.join(home,".nexus"),path.join(home,".nexus/sessions"),sessionDir,path.join(home,".config"),configDir]) fs.chmodSync(directory,0o700);
   fs.writeFileSync(path.join(sessionDir,"events.jsonl"),"durable session",{mode:0o600});
   fs.writeFileSync(path.join(configDir,"config.env"),"MODEL=durable\n",{mode:0o600});

   fsDefault.fsyncSync=((fd:number)=>{
    const stat=fsDefault.fstatSync(fd);
    flushed.add(`${stat.dev}:${stat.ino}`);
    return originalFsync(fd);
   }) as typeof fsDefault.fsyncSync;
   syncBuiltinESMExports();
   const backup=createPreMigrationBackup(home);
   assert.ok(backup.configBackupPath);
   assert.ok(backup.stateBackupDir);
   const expectedFiles=[
    backup.configBackupPath!,
    path.join(backup.stateBackupDir!,"backup.json"),
    path.join(backup.stateBackupDir!,"state","sessions","a","events.jsonl"),
    path.join(backup.stateBackupDir!,"config","config.env"),
   ];
   for(const file of expectedFiles){
    const stat=fs.statSync(file);
    assert.ok(flushed.has(`${stat.dev}:${stat.ino}`),`backup file was not fsynced: ${file}`);
   }
   const expectedDirectories=[
    path.dirname(backup.configBackupPath!),
    backup.stateBackupDir!,
    path.join(backup.stateBackupDir!,"state"),
    path.join(backup.stateBackupDir!,"state","sessions"),
    path.join(backup.stateBackupDir!,"state","sessions","a"),
    path.join(backup.stateBackupDir!,"config"),
   ];
   for(const directory of expectedDirectories){
    const stat=fs.statSync(directory);
    assert.ok(flushed.has(`${stat.dev}:${stat.ino}`),`backup directory was not fsynced: ${directory}`);
   }
  }finally{
   fsDefault.fsyncSync=originalFsync;
   syncBuiltinESMExports();
   fs.rmSync(home,{recursive:true,force:true});
  }
 });

 it("preserves an existing backup when exclusive creation reports EEXIST",()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"nexus-backup-eexist-"));
  const originalOpenSync=fsDefault.openSync;
  let collidedPath:string|undefined;
  try{
   const configDir=path.join(home,".config/nexus");
   fs.mkdirSync(configDir,{recursive:true,mode:0o700});
   fs.chmodSync(path.join(home,".config"),0o700);fs.chmodSync(configDir,0o700);
   fs.writeFileSync(path.join(configDir,"config.env"),"MODEL=source\n",{mode:0o600});
   fsDefault.openSync=((file:any,flags:any,mode?:any)=>{
    if(!collidedPath && typeof file==="string" && file.includes(`${path.sep}config.env.bak.`) && (flags & fs.constants.O_EXCL)!==0){
     collidedPath=file;
     const fd=originalOpenSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);
     try{fsDefault.writeSync(fd,"keep pre-existing backup\n");}finally{fsDefault.closeSync(fd);}
     throw Object.assign(new Error("backup already exists"),{code:"EEXIST"});
    }
    return originalOpenSync(file,flags,mode);
   }) as typeof fsDefault.openSync;
   syncBuiltinESMExports();
   assert.throws(()=>createPreMigrationBackup(home),(error:any)=>error.code==="EEXIST");
   assert.ok(collidedPath,"exclusive backup creation was attempted");
  }finally{
   fsDefault.openSync=originalOpenSync;
   syncBuiltinESMExports();
  }
  try{assert.equal(fs.readFileSync(collidedPath!,"utf8"),"keep pre-existing backup\n");}
  finally{fs.rmSync(home,{recursive:true,force:true});}
 });

 it("does not merge into an existing timestamped state backup directory",()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"nexus-state-backup-eexist-"));
  const originalMkdirSync=fsDefault.mkdirSync;
  let collidedPath:string|undefined;
  try{
   const sessionDir=path.join(home,".nexus/sessions/a");
   fs.mkdirSync(sessionDir,{recursive:true,mode:0o700});
   fs.chmodSync(path.join(home,".nexus"),0o700);fs.chmodSync(path.join(home,".nexus/sessions"),0o700);fs.chmodSync(sessionDir,0o700);
   fs.writeFileSync(path.join(sessionDir,"events.jsonl"),"MODEL=state source\n",{mode:0o600});
   fsDefault.mkdirSync=((directory:any,options?:any)=>{
    if(!collidedPath && typeof directory==="string" && directory.includes(`${path.sep}state-backup-`)){
     collidedPath=directory;
     originalMkdirSync(directory,{mode:0o700});
     fsDefault.writeFileSync(path.join(directory,"sentinel.txt"),"keep existing partial backup\n",{mode:0o600});
    }
    return originalMkdirSync(directory,options);
   }) as typeof fsDefault.mkdirSync;
   syncBuiltinESMExports();
   assert.throws(()=>createPreMigrationBackup(home),(error:any)=>error.code==="EEXIST");
   assert.ok(collidedPath,"timestamped backup directory creation was attempted");
  }finally{
   fsDefault.mkdirSync=originalMkdirSync;
   syncBuiltinESMExports();
  }
  try{
   assert.deepEqual(fs.readdirSync(path.dirname(collidedPath!)),[path.basename(collidedPath!)]);
   assert.deepEqual(fs.readdirSync(collidedPath!),["sentinel.txt"]);
   assert.equal(fs.readFileSync(path.join(collidedPath!,"sentinel.txt"),"utf8"),"keep existing partial backup\n");
  }finally{fs.rmSync(home,{recursive:true,force:true});}
 });

 it("keeps committed restore barriers until staged payload cleanup succeeds",()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"nexus-restore-cleanup-retry-"));
  const originalRmSync=fsDefault.rmSync;
  let injected=false;
  try{
   const source=path.join(home,"source-config");
   const configDir=path.join(home,".config/nexus");
   fs.mkdirSync(source,{mode:0o700});
   fs.mkdirSync(configDir,{recursive:true,mode:0o700});
   fs.chmodSync(path.join(home,".config"),0o700);fs.chmodSync(configDir,0o700);
   fs.writeFileSync(path.join(source,"config.env"),"MODEL=restored\n",{mode:0o600});
   fs.writeFileSync(path.join(configDir,"config.env"),"MODEL=before\n",{mode:0o600});
   fsDefault.rmSync=((target:any,options:any)=>{
    if(!injected && String(target).includes(`${path.sep}restore-control${path.sep}transactions${path.sep}`)){
     injected=true;
     const error=Object.assign(new Error("injected transaction cleanup failure"),{code:"EIO"});
     throw error;
    }
    return originalRmSync(target,options);
   }) as typeof fsDefault.rmSync;
   syncBuiltinESMExports();
   assert.equal(restoreFromSources(home,[{store:"config",source,mode:"tree"}]),false);
   assert.equal(injected,true,"the test must exercise staging cleanup failure");
   assert.equal(fs.readFileSync(path.join(configDir,"config.env"),"utf8"),"MODEL=restored\n");
   assert.equal(hasPendingStateRestore(home),true,"the committed journal must remain as a retry route");
   const activePath=path.join(home,".nexus/restore-control/active.json");
   const active=JSON.parse(fs.readFileSync(activePath,"utf8"));
   assert.equal(active.phase,"committed");
   assert.ok(fs.existsSync(path.join(configDir,".nexus-restore.pending")),"the store barrier must remain until cleanup succeeds");
  }finally{
   fsDefault.rmSync=originalRmSync;
   syncBuiltinESMExports();
  }
  try{
   assert.equal(recoverPendingStateRestore(home),true,"recovery must retry committed transaction cleanup");
   assert.equal(hasPendingStateRestore(home),false);
   assert.equal(fs.existsSync(path.join(home,".nexus/restore-control/active.json")),false);
   assert.deepEqual(fs.readdirSync(path.join(home,".nexus/restore-control/transactions")),[]);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
 });

 it("replays a prepared restore after interruption and blocks state access until recovery",()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"nexus-restore-replay-"));
  try{
   const nexus=path.join(home,".nexus"), tasks=path.join(nexus,"tasks");
   fs.mkdirSync(tasks,{recursive:true,mode:0o700});
   fs.writeFileSync(path.join(tasks,"item.txt"),"partially restored",{mode:0o600});
   const id="6b9c1f71-137e-4ee9-b81e-9457c0e5812b";
   const control=path.join(nexus,"restore-control"), tx=path.join(control,"transactions",id), payload=path.join(tx,"payload","state");
   fs.mkdirSync(path.join(payload,"tasks"),{recursive:true,mode:0o700});
   fs.writeFileSync(path.join(payload,"tasks/item.txt"),"authoritative backup",{mode:0o600});
   fs.mkdirSync(tasks,{recursive:true,mode:0o700});
   const digest=(value:Buffer|string)=>crypto.createHash("sha256").update(value).digest("hex");
   const stores={state:"tree" as const,config:null};
   const manifest={formatVersion:1,homeSha256:digest(fs.realpathSync(home)),stores,entries:[
    {store:"state",path:"tasks",kind:"directory"},
    {store:"state",path:"tasks/item.txt",kind:"file",size:Buffer.byteLength("authoritative backup"),sha256:digest("authoritative backup")},
   ]};
   const manifestSha256=digest(JSON.stringify(manifest));
   fs.writeFileSync(path.join(tx,"manifest.json"),JSON.stringify(manifest),{mode:0o600});
   fs.writeFileSync(path.join(control,"active.json"),JSON.stringify({formatVersion:1,id,homeSha256:digest(fs.realpathSync(home)),manifestSha256,phase:"prepared",stores}),{mode:0o600});

   assert.equal(hasPendingStateRestore(home),true);
   fs.symlinkSync("missing-marker-target",path.join(tasks,".nexus-restore.pending"));
   assert.equal(recoverPendingStateRestore(home),false,"a dangling per-store marker must not be mistaken for an absent marker");
   assert.equal(hasPendingStateRestore(home),true,"the durable journal must remain after marker validation fails");
   fs.unlinkSync(path.join(tasks,".nexus-restore.pending"));
   assert.throws(()=>withStateStoreGuard(tasks,()=>"must not read or write"),/restore is pending/i);
   fs.writeFileSync(path.join(payload,"tasks/item.txt"),"tampered payload");
   assert.equal(recoverPendingStateRestore(home),false);
   assert.equal(hasPendingStateRestore(home),true);
   assert.throws(()=>withStateStoreGuard(tasks,()=>"must not read or write"),/restore is pending/i);
   fs.writeFileSync(path.join(payload,"tasks/item.txt"),"authoritative backup");
   assert.equal(recoverPendingStateRestore(home),true);
   assert.equal(hasPendingStateRestore(home),false);
   assert.equal(fs.readFileSync(path.join(tasks,"item.txt"),"utf8"),"authoritative backup");
   assert.equal(fs.existsSync(path.join(tasks,".nexus-restore.pending")),false);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
 });

 it("fails closed when a per-store marker survives without its global journal",()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"nexus-restore-orphan-marker-"));
  try{
   const tasks=path.join(home,".nexus/tasks");
   fs.mkdirSync(tasks,{recursive:true,mode:0o700});
   fs.writeFileSync(path.join(tasks,".nexus-restore.pending"),JSON.stringify({formatVersion:1,id:"interrupted"}),{mode:0o600});
   assert.throws(()=>hasPendingStateRestore(home),/without its global journal/i);
   assert.equal(recoverPendingStateRestore(home),false);
   assert.throws(()=>withStateStoreGuard(tasks,()=>"must remain blocked"),/restore is pending/i);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
 });

 it("fails closed on dangling active and per-store restore markers",()=>{
  const activeHome=fs.mkdtempSync(path.join(os.tmpdir(),"nexus-restore-dangling-active-"));
  const storeHome=fs.mkdtempSync(path.join(os.tmpdir(),"nexus-restore-dangling-store-"));
  try{
   const control=path.join(activeHome,".nexus/restore-control");
   fs.mkdirSync(control,{recursive:true,mode:0o700});
   fs.chmodSync(path.join(activeHome,".nexus"),0o700);fs.chmodSync(control,0o700);
   fs.symlinkSync("missing-active-target.json",path.join(control,"active.json"));
   assert.throws(()=>hasPendingStateRestore(activeHome),/restore control file.*redirected|not private/i);
   assert.equal(recoverPendingStateRestore(activeHome),false);

   const tasks=path.join(storeHome,".nexus/tasks");
   fs.mkdirSync(tasks,{recursive:true,mode:0o700});fs.chmodSync(path.join(storeHome,".nexus"),0o700);
   fs.symlinkSync("missing-store-target",path.join(tasks,".nexus-restore.pending"));
   assert.throws(()=>hasPendingStateRestore(storeHome),/restore control file.*redirected|not private/i);
   assert.throws(()=>withStateStoreGuard(tasks,()=>"must remain blocked"),/restore barrier is redirected/i);
  }finally{fs.rmSync(activeHome,{recursive:true,force:true});fs.rmSync(storeHome,{recursive:true,force:true});}
 });

 it("refuses upgrade --check before loading config when restore is pending",()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"nexus-restore-check-gate-"));
  try{
   const control=path.join(home,".nexus/restore-control");
   fs.mkdirSync(control,{recursive:true,mode:0o700});
   fs.chmodSync(path.join(home,".nexus"),0o700);fs.chmodSync(control,0o700);
   const id="6b9c1f71-137e-4ee9-b81e-9457c0e5812b";
   fs.writeFileSync(path.join(control,"active.json"),JSON.stringify({formatVersion:1,id,homeSha256:crypto.createHash("sha256").update(fs.realpathSync(home)).digest("hex"),manifestSha256:"a".repeat(64),phase:"prepared",stores:{state:"tree",config:null}}),{mode:0o600});
   const cliRoot=path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),"..");
   const result=spawnSync(process.execPath,["--import","tsx","src/index.ts","upgrade","--check"],{cwd:cliRoot,env:{...process.env,HOME:home,XDG_CONFIG_HOME:path.join(home,".config")},encoding:"utf8",timeout:10000});
   assert.equal(result.status,2,`${result.stdout}\n${result.stderr}`);
   assert.match(result.stderr,/Pending state restore must be recovered before running upgrade --check/);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
 });

 it("routes launches before legacy-client census and resumes after the legacy client exits",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"nexus-restore-routing-"));
  const home=path.join(root,"home"), launcher=path.join(root,"legacy","lib/nexus/v1.0.0/bin/nexus");
  fs.mkdirSync(home,{mode:0o700});
  fs.mkdirSync(path.join(home,".nexus/sessions/a"),{recursive:true,mode:0o700});
  fs.mkdirSync(path.join(home,".config/nexus"),{recursive:true,mode:0o700});
  for(const directory of [".nexus",".nexus/sessions",".nexus/sessions/a",".config/nexus"]) fs.chmodSync(path.join(home,directory),0o700);
  fs.writeFileSync(path.join(home,".nexus/sessions/a/events.jsonl"),"original session");
  fs.writeFileSync(path.join(home,".config/nexus/config.env"),"MODEL=original\n");
  const backup=createPreMigrationBackup(home);
  fs.writeFileSync(path.join(home,".nexus/sessions/a/events.jsonl"),"changed during legacy session");
  fs.mkdirSync(path.dirname(launcher),{recursive:true});
  fs.writeFileSync(launcher,"setTimeout(() => {}, 60000);\n");
  const legacy=spawn(process.execPath,[launcher],{env:{...process.env,HOME:home}});
  try{
   await new Promise<void>((resolve,reject)=>{legacy.once("spawn",resolve);legacy.once("error",reject);});
   await new Promise(resolve=>setTimeout(resolve,100));
   let restoreError: unknown;
   assert.equal(restoreConfigBackup(backup.stateBackupDir!,home,error=>{restoreError=error;}),false);
   assert.match(String(restoreError),/legacy Nexus client.*Do not launch version-pinned legacy binaries/i);
   assert.equal(hasPendingStateRestore(home),true,"the durable launcher route must exist before census blocks restore");
   assert.equal(fs.readFileSync(path.join(home,".nexus/sessions/a/events.jsonl"),"utf8"),"changed during legacy session");
   legacy.kill("SIGTERM");
   await new Promise<void>(resolve=>{if(legacy.exitCode!==null||legacy.signalCode!==null)resolve();else legacy.once("exit",()=>resolve());});
   assert.equal(recoverPendingStateRestore(home),true);
   assert.equal(fs.readFileSync(path.join(home,".nexus/sessions/a/events.jsonl"),"utf8"),"original session");
  }finally{
   if(legacy.exitCode===null&&legacy.signalCode===null){legacy.kill("SIGTERM");await new Promise<void>(resolve=>{if(legacy.exitCode!==null||legacy.signalCode!==null)resolve();else legacy.once("exit",()=>resolve());});}
   fs.rmSync(root,{recursive:true,force:true});
  }
 });
});

describe("live transaction exceptions after each destructive boundary",()=>{
 for(const boundary of ["package_preserved","package_moved","provenance_written","launcher_switched","verifying_install","installed_wrong_version","kill_after_package_move"]){
  it(`restores the real previous same-version package after ${boundary}`,async()=>{
   const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"nexus-live-transaction-"));
   const previousBase=process.env.NEXUS_RELEASE_BASE_URL, previousAttest=process.env.NEXUS_VERIFY_ATTESTATION;
   const prefix=path.join(tmp,"prefix"), install=path.join(prefix,"lib/nexus/v1.0.0"), packageDir=path.join(tmp,"stage/nexus");
   runtime(install,"v1.0.0","previous-real-package");runtime(packageDir,"v1.0.0","replacement-package");
   fs.mkdirSync(path.join(prefix,"bin"));fs.symlinkSync(path.join(install,"bin/nexus"),path.join(prefix,"bin/nexus"));
   if (boundary === "installed_wrong_version") fs.writeFileSync(path.join(packageDir,"bin/nexus"), `#!/bin/sh\ncase "$0" in *.tmp-upgrade-*) echo v1.0.0;; *) echo v9.9.9;; esac\n`, { mode:0o755 });
   const candidateMetadata = generateCompatibilityMetadata("v1.0.0","deadbeef");
   candidateMetadata.compatibility.stateSchemaVersion = CURRENT_STATE_SCHEMA_VERSION;
   fs.writeFileSync(path.join(packageDir,"compatibility.json"),JSON.stringify(candidateMetadata));
   const manifest=["VERSION","bin/nexus","lib/core/harness-core","lib/core/nexus-tui","lib/cli/dist/index.js","compatibility.json"].map(name=>crypto.createHash("sha256").update(fs.readFileSync(path.join(packageDir,name))).digest("hex")+"  "+name).join("\n");
   fs.writeFileSync(path.join(packageDir,"MANIFEST.sha256"),manifest);
   const archive=path.join(tmp,"package.tar.gz");assert.equal(spawnSync("tar",["-C",path.join(tmp,"stage"),"-czf",archive,"nexus"]).status,0);
   const body=fs.readFileSync(archive), digest=crypto.createHash("sha256").update(body).digest("hex");
   const server=http.createServer((req,res)=>{
     if(req.url?.endsWith("nexus-linux-x86_64-v1.0.0.tar.gz")) res.end(body);
     else if(req.url?.endsWith("SHA256SUMS")) res.end(`${digest}  nexus-linux-x86_64-v1.0.0.tar.gz\n`);
     else {res.statusCode=404;res.end();}
   });
   await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
   process.env.NEXUS_RELEASE_BASE_URL=`http://127.0.0.1:${(server.address() as any).port}/releases`;process.env.NEXUS_VERIFY_ATTESTATION="0";
   try{
    const installed={version:"v1.0.0", normalizedVersion:"v1.0.0",semver:parseSemver("v1.0.0"),isPrerelease:false,provenance:"packaged" as const,installRoot:install,prefix,binLink:path.join(prefix,"bin/nexus"),writable:true};
    const comparison=compareInstallationWithRelease(installed,{tag_name:"v1.0.0",draft:false,prerelease:false,assets:[]},{force:true});
    if (boundary === "kill_after_package_move") {
      const code = `import { performUpgrade } from './src/upgrade.ts'; await performUpgrade(${JSON.stringify(comparison)}, { prefix:${JSON.stringify(prefix)}, onProgress(stage){ if(stage==='package_moved') process.kill(process.pid,'SIGKILL'); } });`;
      const child = spawn(process.execPath,["--import","tsx","--input-type=module","-e",code],{ cwd:path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),".."), env:{...process.env}, stdio:"pipe" });
      let diagnostics=""; child.stderr.on("data",data=>diagnostics+=data);
      const exit = await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.on("error",reject);child.on("exit",(code,signal)=>resolve({code,signal}));});
      assert.equal(exit.signal,"SIGKILL",diagnostics);
      assert.equal(recoverUpgrade(prefix).action,"rolled_back");
    } else {
      await assert.rejects(performUpgrade(comparison,{prefix,onProgress(stage){if(stage===boundary)throw new Error(`fault at ${boundary}`);}}), boundary === "installed_wrong_version" ? /Installed binary failed self-test/ : new RegExp(`fault at ${boundary}`));
    }
    assert.equal(fs.readFileSync(path.join(install,"marker"),"utf8"),"previous-real-package");
    assert.equal(fs.realpathSync(path.join(prefix,"bin/nexus")),path.join(install,"bin/nexus"));
    assert.equal(readJournal(prefix)?.state,"rolled_back");
    assert.equal(verifyInstalledRuntime(install,"v1.0.0").healthy,true);
   }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(previousBase===undefined)delete process.env.NEXUS_RELEASE_BASE_URL;else process.env.NEXUS_RELEASE_BASE_URL=previousBase;
    if(previousAttest===undefined)delete process.env.NEXUS_VERIFY_ATTESTATION;else process.env.NEXUS_VERIFY_ATTESTATION=previousAttest;
    fs.rmSync(tmp,{recursive:true,force:true});
   }
  });
 }
});

it("rollback preserves permanent state guard inodes absent from an older snapshot", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-rollback-guard-"));
  try {
    fs.mkdirSync(path.join(home, ".nexus"), { mode: 0o700 });
    const backup = createPreMigrationBackup(home);
    const taskGuard = path.join(home, ".nexus/tasks/.nexus-state.guard");
    const before = fs.statSync(taskGuard).ino;
    fs.mkdirSync(path.join(home, ".nexus/tasks/nested"), { recursive: true, mode: 0o700 });
    const nestedGuard = path.join(home, ".nexus/tasks/nested/.nexus-state.guard");
    fs.writeFileSync(nestedGuard, "", { mode: 0o600 }); const nestedInode = fs.statSync(nestedGuard).ino;
    fs.writeFileSync(path.join(home, ".nexus/tasks/nested/obsolete"), "old");
    assert.equal(restoreConfigBackup(backup.stateBackupDir!, home), true);
    assert.equal(fs.statSync(taskGuard).ino, before);
    assert.equal(fs.statSync(nestedGuard).ino, nestedInode);
    assert.equal(fs.existsSync(path.join(home, ".nexus/tasks/nested/obsolete")), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
