import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync,execFileSync} from 'node:child_process';
const files=['start.bat','start-mock.bat','test.bat'];const windows=process.platform==='win32';
function fixture(name:string,lock=true){const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq launcher '));const cwd=path.join(root,'project with spaces & chars');fs.mkdirSync(cwd);const bin=path.join(root,'tools with spaces');fs.mkdirSync(bin);const calls=path.join(root,'calls.txt');for(const file of files)fs.copyFileSync(file,path.join(cwd,file));if(lock)fs.writeFileSync(path.join(cwd,'package-lock.json'),'{}');
const script=`@echo off
setlocal
if defined LAUNCHER_CODEPAGE_LOG chcp > "%LAUNCHER_CODEPAGE_LOG%"
if defined LAUNCHER_UTF8_FILE type "%LAUNCHER_UTF8_FILE%"
echo %*>>"%LAUNCHER_CALL_LOG%"
if "%1"=="ci" goto install
if "%1"=="install" goto install
exit /b %FAKE_RUN_EXIT%
:install
if defined FAKE_INSTALL_FAIL exit /b %FAKE_INSTALL_FAIL%
mkdir "node_modules\\.bin" 2>nul
mkdir "node_modules\\sharp" 2>nul
type nul > "node_modules\\.bin\\tsx.cmd"
type nul > "node_modules\\sharp\\package.json"
exit /b 0
`;
fs.writeFileSync(path.join(bin,'npm.cmd'),script.replaceAll('\n','\r\n'),'ascii');
const run=(file=name,env:Record<string,string>={},prefix='')=>spawnSync('cmd.exe',['/d','/c',prefix+'call '+file],{cwd,windowsHide:true,encoding:'utf8',timeout:15000,windowsVerbatimArguments:true,env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toLowerCase()!=='path')),PATH:bin+';'+path.join(process.env.SystemRoot??'C:\\Windows','System32'),QQ_AGENT_NO_PAUSE:'1',LAUNCHER_CALL_LOG:calls,FAKE_RUN_EXIT:'0',...env}});
return {root,cwd,run,commands:()=>fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split(/\r?\n/):[],close:()=>fs.rmSync(root,{recursive:true,force:true})};}
test('Windows脚本为无BOM ASCII和CRLF，不包含LF单独换行',()=>{for(const file of files){const bytes=fs.readFileSync(file);assert.ok([...bytes].every(b=>b<128),file);const text=bytes.toString('ascii');assert.ok(text.startsWith('@echo off\r\n'),file);assert.ok(!/(?<!\r)\n/.test(text),file);}});
test('Git规则保留批处理原始CRLF，不能只有checkout转换规则',()=>{const attributes=fs.readFileSync('.gitattributes','utf8');assert.match(attributes,/^\*\.bat\s+-text\s*$/m);assert.match(attributes,/^\*\.cmd\s+-text\s*$/m);});
test('三个脚本从936代码页启动时，安装与运行前均切换UTF-8，中文输出完整',{skip:!windows},()=>{
const original=spawnSync('cmd.exe',['/d','/c','chcp'],{encoding:'utf8'}).stdout.match(/\d+/)?.[0];
try{for(const file of files){const f=fixture(file);try{
 const codepage=path.join(f.root,'codepage.txt'),text=path.join(f.root,'chinese.txt');
 fs.writeFileSync(text,'QQ Agent 启动中，数据库已就绪，已加载7个人格\r\n','utf8');
 const r=f.run(file,{LAUNCHER_CODEPAGE_LOG:codepage,LAUNCHER_UTF8_FILE:text},'chcp 936 >nul & ');
 assert.equal(r.status,0,r.stdout+r.stderr);assert.match(fs.readFileSync(codepage,'utf8'),/65001/);
 assert.equal(r.stdout.split('QQ Agent 启动中，数据库已就绪，已加载7个人格').length-1,2);
}finally{f.close();}}}finally{if(original)spawnSync('cmd.exe',['/d','/c','chcp '+original+' >nul'],{windowsHide:true});}
});
for(const [file,expected] of [['start.bat','run start'],['start-mock.bat','run mock:onebot'],['test.bat','test']])test(file+'在含空格与&的目录首次安装并运行正确命令',{skip:!windows},()=>{const f=fixture(file!);try{const r=f.run();assert.equal(r.error,undefined);assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(r.stderr.trim(),'');assert.deepEqual(f.commands(),['ci --no-fund --no-audit',expected]);}finally{f.close();}});
test('存在不完整node_modules仍安装，安装完成后不重复安装',{skip:!windows},()=>{const f=fixture('start.bat');try{fs.mkdirSync(path.join(f.cwd,'node_modules'));assert.equal(f.run().status,0);assert.equal(f.run().status,0);assert.deepEqual(f.commands(),['ci --no-fund --no-audit','run start','run start']);}finally{f.close();}});
test('没有锁文件时兼容使用npm install',{skip:!windows},()=>{const f=fixture('start.bat',false);try{assert.equal(f.run().status,0);assert.deepEqual(f.commands(),['install --no-fund --no-audit','run start']);}finally{f.close();}});
test('安装失败立即停止，不继续启动或测试',{skip:!windows},()=>{for(const file of files){const f=fixture(file);try{const r=f.run(file,{FAKE_INSTALL_FAIL:'7'});assert.equal(r.status,1);assert.deepEqual(f.commands(),['ci --no-fund --no-audit']);assert.match(r.stdout,/Dependency installation failed/);}finally{f.close();}}});
test('运行失败保留退出码',{skip:!windows},()=>{for(const file of files){const f=fixture(file);try{const r=f.run(file,{FAKE_RUN_EXIT:'42'});assert.equal(r.status,42);}finally{f.close();}}});
const gitAvailable=spawnSync('git',['--version'],{encoding:'utf8'}).status===0;
test('模拟GitHub源码导出：autocrlf开启后Git存储/归档/解压仍可执行',{skip:!windows||!gitAvailable},()=>{const f=fixture('start.bat');try{fs.copyFileSync('.gitattributes',path.join(f.cwd,'.gitattributes'));const git=(...args:string[])=>execFileSync('git',['-c','safe.directory='+f.cwd,'-c','core.autocrlf=true','-c','user.name=Launcher Test','-c','user.email=launcher@example.invalid',...args],{cwd:f.cwd,windowsHide:true,stdio:'pipe'});git('init','-b','main');git('add','.gitattributes',...files);git('commit','-m','launcher archive regression');for(const file of files){const blob=git('show','HEAD:'+file);assert.deepEqual(blob,fs.readFileSync(file));}
const archive=path.join(f.root,'source.tar');git('archive','--format=tar','--output='+archive,'HEAD');const unpack=path.join(f.cwd,'download zip extracted');fs.mkdirSync(unpack);execFileSync('tar',['-xf',archive,'-C',unpack],{windowsHide:true});for(const file of files)assert.deepEqual(fs.readFileSync(path.join(unpack,file)),fs.readFileSync(file));const r=f.run('"download zip extracted\\start.bat"');assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(r.stderr.trim(),'');assert.deepEqual(f.commands(),['install --no-fund --no-audit','run start']);}finally{f.close();}});
