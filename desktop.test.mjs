import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

for (const mode of ['shutdown', 'pipe-close']) test('desktop service saves and exits on owned ' + mode, async () => {
  const data = await mkdtemp(join(tmpdir(), 'daymark-desktop-server-'));
  const child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, DAYMARK_DESKTOP: '1', STUDENT_INBOX_MODE: 'local', STUDENT_INBOX_DATA_DIR: data, HOST: '127.0.0.1', PORT: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', () => {});
  try {
    for (let n=0; n<200 && !output.includes('Access code:'); n++) { assert.equal(child.exitCode,null); await delay(25); }
    const base = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; assert(base);
    assert.equal((await fetch(base+'/api/health')).status,200);
    const paired = await fetch(base+'/api/pair',{method:'POST',body:JSON.stringify({code:output.match(/Access code: ([\w-]+)/)[1]})});
    assert.equal(paired.status,200); const cookie=paired.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base+'/api/state',{headers:{cookie}})).status,200);
    assert.equal((await fetch(base+'/api/desktop/shutdown',{method:'POST'})).status,401,'no public shutdown endpoint');
    if(mode==='shutdown') child.stdin.end('shutdown\n'); else child.stdin.end();
    for(let n=0;n<200 && child.exitCode===null;n++) await delay(25);
    assert.equal(child.exitCode,0); assert(Array.isArray(JSON.parse(await readFile(join(data,'inbox.json'),'utf8')).items));
    await assert.rejects(fetch(base+'/api/health'));
  } finally { if(child.exitCode===null) child.kill(); await rm(data,{recursive:true,force:true,maxRetries:5}); }
});
