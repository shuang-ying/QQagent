import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
/** 同目录临时文件、fsync、rename；多文件出错时恢复原文件。 */
export function atomicWriteMany(entries: Array<[string,string]>): void {
 const originals = entries.map(([file])=>fs.existsSync(file)?fs.readFileSync(file):null);
 const temps:string[]=[];let published=0;
 try {
  for(const [file,text] of entries){const tmp=path.join(path.dirname(file),`.${path.basename(file)}.${randomUUID()}.tmp`);temps.push(tmp);const fd=fs.openSync(tmp,'wx',0o600);try {fs.writeFileSync(fd,text,'utf8');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  for(let i=0;i<entries.length;i++){fs.renameSync(temps[i]!,entries[i]![0]);published++;}
 } catch(e) {
  for(let i=0;i<published;i++){const original=originals[i];if(original)fs.writeFileSync(entries[i]![0],original);else fs.rmSync(entries[i]![0],{force:true});}
  throw e;
 } finally {for(const tmp of temps)fs.rmSync(tmp,{force:true});}
}
export function atomicWrite(file:string,text:string):void {atomicWriteMany([[file,text]]);}
