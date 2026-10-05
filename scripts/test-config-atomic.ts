import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setConfigValues} from '../src/config/writer.js';
import {atomicWriteMany} from '../src/config/atomic.js';
test('配置校验失败不改原文件，多文件准备失败不半发布',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-config-'));
 try {
  const file=path.join(dir,'app.yaml');const original=fs.readFileSync('config/app.yaml','utf8');fs.writeFileSync(file,original);
  assert.throws(()=>setConfigValues(file,[[['server','port'],-1]]));assert.equal(fs.readFileSync(file,'utf8'),original);
  assert.throws(()=>atomicWriteMany([[file,'new'],[path.join(dir,'missing','p.yaml'),'x']]));assert.equal(fs.readFileSync(file,'utf8'),original);
  setConfigValues(file,[[['app','name'],'atomic-test']]);assert.ok(fs.readFileSync(file,'utf8').includes('atomic-test'));assert.equal(fs.readdirSync(dir).filter(x=>x.endsWith('.tmp')).length,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
