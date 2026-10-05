import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {MemoryStore} from '../src/memory/store.js';
import {backupDatabase,checkDatabase,restoreDatabaseOffline} from '../src/memory/maintenance.js';
test('在线 WAL 备份、完整性、离线恢复和新版本拒绝降级',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-db-'));const file=path.join(dir,'memory.db'),backup=path.join(dir,'backup.db');
 try {
  const store=new MemoryStore(file);store.addFact({userId:1,scope:'private:1',factType:'identity',content:'工程师'});backupDatabase(store.db,backup);store.close();checkDatabase(backup);
  restoreDatabaseOffline(backup,file);const reopened=new MemoryStore(file);assert.equal(reopened.listFacts(1).length,1);reopened.db.prepare("UPDATE meta SET value='999' WHERE key='schema_version'").run();reopened.close();assert.throws(()=>new MemoryStore(file),/拒绝降级/);
  const corrupt=path.join(dir,'bad.db');fs.writeFileSync(corrupt,'bad');assert.throws(()=>restoreDatabaseOffline(corrupt,file));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('迁移失败事务回滚且不更新版本',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-migrate-'));const file=path.join(dir,'memory.db');
 try {
  const store=new MemoryStore(file);store.db.exec("UPDATE meta SET value='2' WHERE key='schema_version'; DROP TABLE fact_cursors; CREATE TRIGGER fail_version BEFORE UPDATE ON meta BEGIN SELECT RAISE(ABORT,'migration failure'); END;");store.close();
  assert.throws(()=>new MemoryStore(file),/migration failure/);
  const db=new DatabaseSync(file);assert.equal((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as any).value,'2');assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='fact_cursors'").get(),undefined);db.close();assert.ok(fs.readdirSync(dir).some(x=>x.endsWith('.bak')));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
