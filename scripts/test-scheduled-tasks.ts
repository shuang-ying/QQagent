import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { MemoryStore } from '../src/memory/store.js';
import { AppConfigSchema, PersonaSchema } from '../src/core/types.js';
import { ScheduledTasks, parseReminder, naturalReminder, zonedTime, nextDaily } from '../src/tasks/scheduled.js';
import { TriggerPolicy } from '../src/persona/trigger.js';
import { OneBotActionError } from '../src/onebot/action.js';
import type { OneBotAction } from '../src/onebot/action.js';
import type { ProviderManager } from '../src/llm/manager.js';
import { CommandHandler } from '../src/pipeline/commands.js';
import { PersonaManager } from '../src/persona/manager.js';
import { createServer } from '../src/server/api.js';
const log = pino({ level: 'silent' });
function fixture(db = ':memory:') {
    const cfg = AppConfigSchema.parse({ tasks: { dailyEnabled: true }, trigger: { commandAdminOnly: false, admins: [1] } }), store = new MemoryStore(db), trigger = new TriggerPolicy(cfg.trigger, log);
    let sends = 0, online = true, input = '';
    const api = { sendToScope: async () => { sends++; return { message_id: sends }; } } as unknown as OneBotAction;
    const providers = { resolveRole: () => ({ provider: 'fake', model: 'summary' }), chat: async (messages: any[]) => { input = messages[1].content; return { content: '测试日报：讨论了工作安排。' }; } } as unknown as ProviderManager;
    const tasks = new ScheduledTasks(cfg, store, providers, api, trigger, log, () => online);
    const personas = new PersonaManager([PersonaSchema.parse({ id: 'test', name: '测试' })], cfg, store, log), commands = new CommandHandler(cfg, store, personas, log, tasks);
    return { cfg, store, api, tasks, providers, personas, commands, online: (value: boolean) => online = value, sends: () => sends, input: () => input };
}
const ctx = (user = 1, scope = 'private:1') => ({ scope, scopeType: scope.startsWith('group') ? 'group' as const : 'private' as const, userId: user, senderName: '测试', isAdmin: user === 1, canUseCommands: true, canSwitchPersona: true });
test('提醒支持相对时间、中文时间和应用时区', () => { const now = Date.parse('2026-10-05T01:00:00Z'); assert.equal(parseReminder('10m 喝水', 'Asia/Shanghai', now).dueAt, now + 600000); assert.equal(parseReminder('明天09:00 开会', 'Asia/Shanghai', now).dueAt, Date.parse('2026-10-06T01:00:00Z')); assert.equal(parseReminder('2026-10-06 09:00 开会', 'Asia/Shanghai', now).dueAt, Date.parse('2026-10-06T01:00:00Z')); });
test('自然提醒采用明确语法，不误抓取聊天引用', () => { assert.equal(naturalReminder('10分钟后提醒我喝水'), '10分钟 喝水'); assert.equal(naturalReminder('明天9点提醒我开会'), '明天9:00 开会'); assert.equal(naturalReminder('他说“10分钟后提醒我喝水”'), null); });
test('非法日期、过期时间、空内容和超远时间被拒绝', () => { const now = Date.parse('2026-10-05T01:00:00Z'); for (const raw of ['0m 喝水', '10m', '2026-02-30 09:00 无效', '2028-10-05 09:00 太远'])
    assert.throws(() => parseReminder(raw, 'Asia/Shanghai', now)); });
test('每日时间计算跨日与夏令时', () => { const now = Date.parse('2026-10-05T14:00:00Z'); assert.equal(nextDaily(now, '21:00', 'Asia/Shanghai'), Date.parse('2026-10-06T13:00:00Z')); assert.equal(zonedTime('2026-10-05', '09:00', 'Asia/Shanghai'), Date.parse('2026-10-05T01:00:00Z')); assert.throws(() => zonedTime('2026-03-08', '02:30', 'America/New_York')); assert.ok(nextDaily(Date.parse('2026-03-08T00:00:00Z'), '02:30', 'America/New_York') > Date.parse('2026-03-08T00:00:00Z')); });
test('提醒成功投递、入库且重复tick不重复发送', async () => { const f = fixture(); try {
    const now = Date.now(), t = f.tasks.createReminder('private:1', 1, '喝水', now + 1000, now);
    await f.tasks.tick(now + 1100);
    await f.tasks.tick(now + 1200);
    assert.equal(f.sends(), 1);
    assert.equal(f.tasks.list()[0]!.state, 'sent');
    assert.equal(f.tasks.list()[0]!.id, t.id);
    assert.ok(f.store.getRecentMessages('private:1', 10).some(row => row.content.includes('喝水')));
}
finally {
    f.store.close();
} });
test('离线保持待执行，上线后在宽限内补发', async () => { const f = fixture(); try {
    const now = Date.now();
    f.tasks.createReminder('private:1', 1, '喝水', now + 1000, now);
    f.online(false);
    await f.tasks.tick(now + 1100);
    assert.equal(f.sends(), 0);
    assert.equal(f.tasks.list()[0]!.state, 'pending');
    f.online(true);
    await f.tasks.tick(now + 1200);
    assert.equal(f.sends(), 1);
}
finally {
    f.store.close();
} });
test('待执行期间白名单变更会阻止投递', async () => { const f = fixture(); try {
    const now = Date.now();
    f.tasks.createReminder('group:123', 1, '喝水', now + 1000, now);
    f.cfg.trigger.group.enabledGroups = [456];
    await f.tasks.tick(now + 1100);
    assert.equal(f.sends(), 0);
    assert.equal(f.tasks.list()[0]!.state, 'failed');
}
finally {
    f.store.close();
} });
test('后台目标私聊的接收者也必须符合白名单', () => { const f = fixture(); try {
    f.cfg.trigger.allowUsers = [1];
    assert.throws(() => f.tasks.createReminder('private:2', 1, '内容', Date.now() + 5000), /白名单/);
}
finally {
    f.store.close();
} });
test('超出补发宽限的旧提醒标为expired', async () => { const f = fixture(); try {
    const now = Date.now();
    f.cfg.tasks.overdueGraceMs = 1000;
    f.tasks.createReminder('private:1', 1, '旧提醒', now + 1000, now);
    await f.tasks.tick(now + 3000);
    assert.equal(f.sends(), 0);
    assert.equal(f.tasks.list()[0]!.state, 'expired');
}
finally {
    f.store.close();
} });
test('已知未投递失败最多重试三次，记录错误', async () => { const f = fixture(); try {
    const now = Date.now();
    let calls = 0;
    f.api.sendToScope = async () => { calls++; throw new OneBotActionError('send_private_msg', 'failed', -1, '未连接', 'failed'); };
    f.tasks.createReminder('private:1', 1, '重试', now + 1000, now);
    await f.tasks.tick(now + 1100);
    await f.tasks.tick(now + 62000);
    await f.tasks.tick(now + 123000);
    await f.tasks.tick(now + 184000);
    assert.equal(calls, 3);
    assert.equal(f.tasks.list()[0]!.state, 'failed');
}
finally {
    f.store.close();
} });
test('超时或回执缺失结果未知，不自动重复投递', async () => { for (const missing of [false, true]) {
    const f = fixture();
    try {
        const now = Date.now();
        let calls = 0;
        f.api.sendToScope = async () => { calls++; if (missing)
            return {} as never; throw new OneBotActionError('send_private_msg', 'failed', -1, 'timeout', 'unknown'); };
        f.tasks.createReminder('private:1', 1, '提醒', now + 1000, now);
        await f.tasks.tick(now + 1100);
        await f.tasks.tick(now + 121000);
        assert.equal(calls, 1);
        assert.equal(f.tasks.list()[0]!.state, 'unknown');
    }
    finally {
        f.store.close();
    }
} });
test('重启可恢复pending任务，旧running任务不会重发', async () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tasks-')), db = path.join(dir, 'test.db'); try {
    let f = fixture(db);
    const now = Date.now();
    const a = f.tasks.createReminder('private:1', 1, '恢复', now + 1000, now), b = f.tasks.createReminder('private:1', 1, '未知', now + 1000, now);
    f.store.db.prepare("UPDATE scheduled_tasks SET state='running',updated_at=? WHERE id=?").run(now - 200000, b.id);
    f.store.close();
    f = fixture(db);
    await f.tasks.tick(now + 1100);
    assert.equal(f.tasks.list().find(t => t.id === a.id)?.state, 'sent');
    assert.equal(f.tasks.list().find(t => t.id === b.id)?.state, 'unknown');
    assert.equal(f.sends(), 1);
    f.store.close();
}
finally {
    fs.rmSync(dir, { recursive: true, force: true });
} });
test('重复并发tick只有一份投递', async () => { const f = fixture(); try {
    const now = Date.now();
    f.tasks.createReminder('private:1', 1, '提醒', now + 1000, now);
    await Promise.all([f.tasks.tick(now + 1100), f.tasks.tick(now + 1100)]);
    assert.equal(f.sends(), 1);
}
finally {
    f.store.close();
} });
test('任务所有权、会话范围与个人数量上限', () => { const f = fixture(); try {
    const task = f.tasks.createReminder('group:123', 2, '提醒', Date.now() + 5000);
    assert.equal(f.tasks.cancel(task.id, 'group:123', 3), false);
    assert.equal(f.tasks.cancel(task.id, 'group:456', 2), false);
    assert.equal(f.tasks.cancel(task.id, 'group:123', 2), true);
    f.cfg.tasks.maxPerUser = 1;
    f.tasks.createReminder('private:1', 1, '第一条', Date.now() + 5000);
    assert.throws(() => f.tasks.createReminder('private:1', 1, '第二条', Date.now() + 5000), /上限/);
}
finally {
    f.store.close();
} });
test('日报只读取目标群与24小时窗口，不召回个人记忆', async () => { const f = fixture(); try {
    const now = Date.now();
    for (const [scope, text] of [['group:123', '目标群工作安排'], ['group:456', '其他群秘密'], ['private:1', '私聊秘密']] as Array<[
        string,
        string
    ]>) {
        f.store.touchSession(scope, scope.startsWith('group') ? 'group' : 'private', Number(scope.split(':')[1]), scope);
        f.store.addMessage({ scope, userId: 1, role: 'user', content: text });
    }
    f.store.addMessage({ scope: 'group:123', userId: 1, role: 'user', content: '过期旧消息' });
    f.store.db.prepare('UPDATE messages SET created_at=? WHERE content=?').run(now - 2 * 86400000, '过期旧消息');
    const report = await f.tasks.digest('group:123', now + 100);
    assert.match(report, /测试日报/);
    assert.match(f.input(), /目标群工作安排/);
    assert.ok(!f.input().includes('其他群秘密'));
    assert.ok(!f.input().includes('私聊秘密'));
    assert.ok(!f.input().includes('过期旧消息'));
}
finally {
    f.store.close();
} });
test('日报无记录不调用模型，私聊与关闭功能拒绝', async () => { const f = fixture(); try {
    assert.match(await f.tasks.digest('group:123'), /没有/);
    assert.equal(f.input(), '');
    await assert.rejects(f.tasks.digest('private:1'));
    f.cfg.tasks.dailyEnabled = false;
    await assert.rejects(f.tasks.digest('group:123'));
}
finally {
    f.store.close();
} });
test('定时日报成功后推进到下一天，避免重复注册', async () => { const f = fixture(); try {
    const now = Date.now(), task = f.tasks.createDaily('group:123', 1, '23:59', now);
    assert.throws(() => f.tasks.createDaily('group:123', 1, '21:00', now), /已有/);
    await f.tasks.tick(task.due_at);
    assert.equal(f.sends(), 1);
    assert.equal(f.tasks.list()[0]!.state, 'pending');
    assert.ok(f.tasks.list()[0]!.due_at > task.due_at);
}
finally {
    f.store.close();
} });
test('新指令沿用权限，非所有者不能取消，定时日报只允许管理员配置', async () => { const f = fixture(); try {
    const result = await f.commands.tryHandle('/remind 10m 喝水', ctx(2, 'group:123'));
    assert.match(result.reply!, /已创建/);
    const task = f.tasks.list()[0]!;
    assert.match((await f.commands.tryHandle('/cancelremind ' + task.id, ctx(3, 'group:123'))).reply!, /无权限/);
    assert.match((await f.commands.tryHandle('/daily at 21:00', ctx(2, 'group:123'))).reply!, /管理员/);
    f.cfg.trigger.commandPermissions.remind = 'admin';
    assert.match((await f.commands.tryHandle('/remind 10m 内容', ctx(2, 'group:123'))).reply!, /管理员/);
}
finally {
    f.store.close();
} });
test('自然语言私聊提醒和提醒列表可以使用', async () => { const f = fixture(); try {
    assert.match((await f.commands.tryHandle('10分钟后提醒我喝水', ctx())).reply!, /已创建/);
    assert.match((await f.commands.tryHandle('/reminders', ctx())).reply!, /喝水/);
}
finally {
    f.store.close();
} });
test('后台任务API创建、查询、取消和鉴权', async () => { const f = fixture(); try {
    f.cfg.server.authToken = 'test-token';
    const deps: any = { cfg: f.cfg, store: f.store, providers: f.providers, personas: f.personas, log, runtime: () => ({}), tasks: f.tasks }, panel = createServer(deps);
    assert.equal((await panel.app.request('/api/tasks')).status, 401);
    const headers = { 'Authorization': 'Bearer test-token', 'Content-Type': 'application/json' };
    let r = await panel.app.request('/api/tasks', { method: 'POST', headers, body: JSON.stringify({ kind: 'reminder', scope: 'private:1', ownerId: 1, when: '10m', text: '喝水' }) });
    assert.equal(r.status, 200);
    const task = (await r.json()).task;
    r = await panel.app.request('/api/tasks', { headers });
    assert.equal((await r.json()).tasks.length, 1);
    r = await panel.app.request('/api/tasks/' + task.id + '/cancel', { method: 'POST', headers, body: '{}' });
    assert.equal(r.status, 200);
    r = await panel.app.request('/api/tasks', { method: 'POST', headers, body: JSON.stringify({ kind: 'reminder', scope: '../bad', ownerId: 1, when: '10m', text: '喝水' }) });
    assert.equal(r.status, 400);
}
finally {
    f.store.close();
} });
test('日报上下文预算优先覆盖最新消息并保持时间顺序', async () => { const f = fixture(); try {
    f.store.touchSession('group:123', 'group', 123, 'test');
    for (let i = 0; i < 20; i++)
        f.store.addMessage({ scope: 'group:123', userId: 1, role: 'user', content: '消息' + i + ':' + '甲'.repeat(1900) });
    await f.tasks.digest('group:123', Date.now() + 100);
    assert.match(f.input(), /消息19:/);
    assert.ok(!f.input().includes('消息0:'));
    assert.ok(f.input().indexOf('消息18:') < f.input().indexOf('消息19:'));
}
finally {
    f.store.close();
} });

test('超过列表显示上限时任务创建、取消和日报去重仍正确',()=>{const f=fixture();try{const now=Date.now(),old=f.tasks.createReminder('group:123',1,'旧提醒',now+5000,now);for(let i=0;i<201;i++)f.store.db.prepare('INSERT INTO scheduled_tasks(id,kind,scope,owner_id,text,clock,timezone,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('extra-'+i,'reminder','group:123',1000+i,'其他人提醒','','Asia/Shanghai',now+300*86400000,now,now);assert.equal(f.tasks.list('group:123').length,200);const added=f.tasks.createReminder('group:123',1,'新提醒',now+10000,now);assert.equal(added.text,'新提醒');assert.equal(f.tasks.cancel(old.id,'group:123',2),false);assert.equal(f.tasks.cancel(old.id,'group:123',1),true);f.tasks.createDaily('group:123',1,'21:00',now);assert.throws(()=>f.tasks.createDaily('group:123',1,'22:00',now),/已有/);}finally{f.store.close();}});

test('暂停日报不会使其积压任务挡住后续提醒',async()=>{const f=fixture();try{const now=Date.now();f.cfg.trigger.group.enabledGroups=Array.from({length:9},(_,i)=>123+i);for(let i=0;i<9;i++){const task=f.tasks.createDaily('group:'+(123+i),1,'21:00',now);f.store.db.prepare('UPDATE scheduled_tasks SET due_at=? WHERE id=?').run(now+1000,task.id);}f.tasks.createReminder('private:1',1,'正常提醒',now+2000,now);f.cfg.tasks.dailyEnabled=false;await f.tasks.tick(now+3000);assert.equal(f.sends(),1);assert.equal(f.tasks.list('private:1')[0]!.state,'sent');assert.ok(f.tasks.list().filter(t=>t.kind==='digest').every(t=>t.state==='pending'));}finally{f.store.close();}});
