import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
/** 备份在线连接包含 WAL 中已提交数据，不使用文件拷贝在线数据库。 */
export function backupDatabase(db:DatabaseSync,target:string):void {
 if(fs.existsSync(target))throw new Error('备份目标已存在');
 db.prepare('VACUUM INTO ?').run(target);checkDatabase(target);
}
export function checkDatabase(file:string):void {
 const db=new DatabaseSync(file,{readOnly:true});
 try {const results=db.prepare('PRAGMA integrity_check').all();if(results.length!==1 || Object.values(results[0]!)[0]!=='ok' || db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('数据库完整性检查失败');}finally{db.close();}
}
/** 仅离线恢复：调用方须先关闭全部连接；保留原文件用于回滚。 */
export function restoreDatabaseOffline(backup:string,target:string):void {
 checkDatabase(backup);
 if(fs.existsSync(target+'-wal') || fs.existsSync(target+'-shm'))throw new Error('存在 WAL/SHM，先停止程序并关闭连接');
 if(fs.existsSync(target))fs.copyFileSync(target,target+'.before-restore.'+Date.now()+'.bak');
 const staged=target+'.restore.tmp';try{fs.copyFileSync(backup,staged);fs.renameSync(staged,target);}finally{fs.rmSync(staged,{force:true});}
}
