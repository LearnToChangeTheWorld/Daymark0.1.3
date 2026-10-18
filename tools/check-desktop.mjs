// Run only against a disposable extracted/installed package, with an empty profile.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
const root=resolve(process.argv[2]||''); assert(process.argv[2]);
const report=process.argv[3] && resolve(process.argv[3]);
const data=await mkdtemp(join(tmpdir(),'daymark-exe-'));
const env={...process.env,PORT:'0',STUDENT_INBOX_DATA_DIR:data,PATH:join(process.env.SystemRoot,'System32')};
const executable=join(root,'Daymark.exe');
const bytes=await readFile(executable); const pe=bytes.readUInt32LE(0x3c); assert.equal(bytes.readUInt16LE(pe+24+68),2,'must be a GUI executable, not a console app');
let child;
const start=args=>spawn(executable,args,{cwd:root,env,windowsHide:true,stdio:'ignore'});
async function ready() {
 for(let n=0;n<200;n++) {
  const error=await readFile(join(data,'desktop-error.txt'),'utf8').catch(()=>null); if(error) throw new Error(error);
  const state=await readFile(join(data,'desktop-state.json'),'utf8').then(JSON.parse).catch(()=>null);
  if(state && state.ownerPid===child.pid) return state;
  assert.equal(child.exitCode,null,'desktop exited before becoming ready'); await delay(100);
 } throw new Error('desktop startup timed out');
}
async function gone(pid) {
 for(let n=0;n<150;n++) { try {process.kill(pid,0);} catch {return;} await delay(100); } throw new Error('owned service was left running');
}
try {
 child=start(['--no-browser','--exit-after=5000',...(report?['--screenshot='+report]:[])]);
 const state=await ready(); assert.equal((await fetch(state.url+'/api/health')).status,200);
 const code=(await readFile(join(data,'access.token'),'utf8')).trim();
 const pair=await fetch(state.url+'/api/pair',{method:'POST',body:JSON.stringify({code})}); assert.equal(pair.status,200);
 assert.equal((await fetch(state.url+'/api/state',{headers:{cookie:pair.headers.get('set-cookie').split(';')[0]}})).status,200);
 const second=start(['--no-browser']); for(let n=0;n<100 && second.exitCode===null;n++) await delay(50); assert.equal(second.exitCode,0);
 assert.equal(JSON.parse(await readFile(join(data,'desktop-state.json'),'utf8')).pid,state.pid);
 for(let n=0;n<200 && child.exitCode===null;n++) await delay(50); assert.equal(child.exitCode,0); await gone(state.pid);
 await assert.rejects(access(join(data,'desktop-state.json')));
 child=start(['--no-browser']); const restarted=await ready();
 child.kill(); await gone(restarted.pid);
 assert(Array.isArray(JSON.parse(await readFile(join(data,'inbox.json'),'utf8')).items));
 console.log(JSON.stringify({ok:true,guiExecutable:true,consoleRequired:false,withoutSystemNodeOrPython:true,health:200,pairing:200,workspace:200,singleInstance:true,gracefulExit:true,crashedLauncherStopsOwnedService:true,preservesData:true}));
} finally {
 if(child && child.exitCode===null) child.kill();
 await delay(500); await rm(data,{recursive:true,force:true,maxRetries:8,retryDelay:100});
}
