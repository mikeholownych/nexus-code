import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { verifyInstalledRuntime } from "../src/upgrade_health.js";
import { writeJournal, readJournal, recoverUpgrade, createPreMigrationBackup, restoreConfigBackup, UpgradeJournalEntry, RecoveryOutcome } from "../src/upgrade_journal.js";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { generateCompatibilityMetadata } from "../src/compatibility.js";
import { performUpgrade, compareInstallationWithRelease, parseSemver, rollbackBinary } from "../src/upgrade.js";

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
    assert.equal(fs.readFileSync(path.join(entry.sourceInstallDir,"marker"),"utf8"),"original");
    assert.equal(verifyInstalledRuntime(entry.sourceInstallDir,"v1.0.0").healthy,true);
    assert.equal(readJournal(prefix)?.state,"rolled_back");
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
    fs.mkdirSync(path.join(home,".nexus/sessions/a"),{recursive:true});fs.mkdirSync(path.join(home,".config/nexus"),{recursive:true});
    const session=path.join(home,".nexus/sessions/a/events.jsonl"), config=path.join(home,".config/nexus/config.env");
    fs.writeFileSync(session,"original session");fs.writeFileSync(config,"MODEL=original\n");
    const backup=createPreMigrationBackup(home);fs.writeFileSync(session,"modified session");fs.writeFileSync(config,"MODEL=modified\n");
    fs.writeFileSync(path.join(home,".nexus/sessions/new-after-backup"),"new");
    assert.equal(restoreConfigBackup(backup.stateBackupDir!,home),true);
    assert.equal(fs.existsSync(path.join(home,".nexus/sessions/new-after-backup")),false);
    assert.equal(fs.readFileSync(session,"utf8"),"original session");assert.equal(fs.readFileSync(config,"utf8"),"MODEL=original\n");
    const archive=path.join(home,"backup.tar.gz");fs.writeFileSync(archive,Buffer.from([0x1f,0x8b,0x08]));
    assert.equal(restoreConfigBackup(archive,home),false);assert.equal(fs.readFileSync(config,"utf8"),"MODEL=original\n");
  }finally{fs.rmSync(home,{recursive:true,force:true});}
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
   fs.writeFileSync(path.join(packageDir,"compatibility.json"),JSON.stringify(generateCompatibilityMetadata("v1.0.0","deadbeef")));
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
