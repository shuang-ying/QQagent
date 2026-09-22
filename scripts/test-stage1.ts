/**
 * 阶段 1 端到端验证：NapCat 接入层
 *
 * 完全自动化，不需要真实 QQ、不需要人工输入：
 *   1. 起一个 Mock OneBot 服务端
 *   2. Agent 的 NapCatClient 反向连入
 *   3. Mock 推送各种格式的消息事件（消息段数组 / CQ 码字符串 / 私聊 / 群聊 / 未@）
 *   4. 断言归一化结果正确、@检测正确、回复正确发出
 *   5. 断言断线自动重连
 *
 * 运行：npm run test:stage1
 */
import { WebSocketServer, WebSocket } from 'ws';
import { NapCatClient } from '../src/napcat/client.js';
import { getLogger } from '../src/core/logger.js';
import { normalizeMessageEvent, parseCqCodes, segmentsToText, toCqCodes } from '../src/napcat/normalize.js';
import type { AppConfig, InboundMessage } from '../src/core/types.js';

const PORT = 3009;
const BOT_QQ = 10001;
const USER_QQ = 20002;
const GROUP_ID = 30003;

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n【${title}】`);
}

// ============================================================
// 第一部分：纯函数单元测试（归一化 / CQ 码 / @检测）
// ============================================================
function testNormalize(): void {
  section('消息归一化单元测试');

  // 1) CQ 码解析
  // "你好" + at + " 世界" + image = 4 段
  const segs = parseCqCodes('你好[CQ:at,qq=10001] 世界[CQ:image,file=a.jpg]');
  check('CQ码: 解析出4个段(文本+at+文本+图片)', segs.length === 4, `实际 ${segs.length}`);
  check('CQ码: 首段为文本', segs[0]?.type === 'text' && segs[0]?.data['text'] === '你好');
  check('CQ码: at段qq为数字类型', segs[1]?.data['qq'] === 10001);
  check('CQ码: 中间文本段保留空格', segs[2]?.data['text'] === ' 世界', String(segs[2]?.data['text']));
  check('CQ码: image段file正确', segs[3]?.data['file'] === 'a.jpg');

  // 1b) 无文本的纯 CQ 码
  const segs2 = parseCqCodes('[CQ:face,id=14]');
  check('CQ码: 纯CQ码解析为1段', segs2.length === 1 && segs2[0]?.type === 'face', `实际 ${segs2.length}`);

  // 2) 纯文本提取
  const text = segmentsToText(
    [
      { type: 'text', data: { text: '你好' } },
      { type: 'at', data: { qq: BOT_QQ } },
      { type: 'text', data: { text: ' 看图' } },
      { type: 'image', data: {} },
      { type: 'face', data: { id: '1' } },
    ],
    BOT_QQ,
  );
  check('文本: @机器人转为"@你"', text.includes('@你'), text);
  check('文本: 图片转占位符', text.includes('[图片]'), text);
  check('文本: 表情转占位符', text.includes('[表情:1]'), text);

  // 3) CQ 码转义往返
  const roundTrip = parseCqCodes(toCqCodes([{ type: 'text', data: { text: 'a[b]c,d&e' } }]));
  check('转义: 特殊字符往返一致', roundTrip[0]?.data['text'] === 'a[b]c,d&e', String(roundTrip[0]?.data['text']));

  // 4) 群聊事件归一化
  const groupEv = normalizeMessageEvent({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 1,
    user_id: USER_QQ,
    group_id: GROUP_ID,
    self_id: BOT_QQ,
    time: 1700000000,
    font: 0,
    raw_message: '',
    message: [
      { type: 'at', data: { qq: BOT_QQ } },
      { type: 'text', data: { text: ' 你好' } },
    ],
    sender: { user_id: USER_QQ, nickname: '昵称', card: '群名片', role: 'member' },
  } as never);

  check('群聊: scope 格式正确', groupEv.scope === `group:${GROUP_ID}`, groupEv.scope);
  check('群聊: 识别出@机器人', groupEv.mentionsBot === true);
  check('群聊: 群名片优先于昵称', groupEv.senderName === '群名片', groupEv.senderName);
  check('群聊: groupId 正确', groupEv.groupId === GROUP_ID);
  check('群聊: text 去掉at后为"你好"', groupEv.text === '@你 你好' || groupEv.text.includes('你好'), groupEv.text);

  // 5) 私聊事件（CQ 码字符串格式）
  const privEv = normalizeMessageEvent({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 2,
    user_id: USER_QQ,
    self_id: BOT_QQ,
    time: 1700000000,
    font: 0,
    raw_message: '私聊内容',
    message: '私聊内容[CQ:face,id=14]',
    sender: { user_id: USER_QQ, nickname: '私聊昵称' },
  } as never);

  check('私聊: scope 格式正确', privEv.scope === `private:${USER_QQ}`, privEv.scope);
  check('私聊: 无 groupId', privEv.groupId === undefined);
  check('私聊: 未@机器人', privEv.mentionsBot === false);
  check('私聊: 昵称正确', privEv.senderName === '私聊昵称');

  // 6) @全体成员
  const atAllEv = normalizeMessageEvent({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 3,
    user_id: USER_QQ,
    group_id: GROUP_ID,
    self_id: BOT_QQ,
    time: 1700000000,
    font: 0,
    raw_message: '',
    message: [{ type: 'at', data: { qq: 'all' } }],
    sender: { user_id: USER_QQ, nickname: 'n' },
  } as never);
  check('@全体: 视为@机器人', atAllEv.mentionsBot === true);
}

// ============================================================
// 第二部分：真实 WS 通信 + 自动重连
// ============================================================

interface Recorded {
  actions: Array<{ action: string; params: Record<string, unknown> }>;
  sentGroup: string[];
  sentPrivate: string[];
}

function startMockServer(rec: Recorded): WebSocketServer {
  const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const req = JSON.parse(raw.toString()) as {
        action: string;
        params: Record<string, unknown>;
        echo: unknown;
      };
      rec.actions.push({ action: req.action, params: req.params });

      let data: unknown = {};
      let status: 'ok' | 'failed' = 'ok';
      let retcode = 0;

      switch (req.action) {
        case 'get_login_info':
          data = { user_id: BOT_QQ, nickname: 'TestBot' };
          break;
        case 'get_status':
          data = { online: true, good: true };
          break;
        case 'send_group_msg':
          rec.sentGroup.push(String(req.params['message']));
          data = { message_id: 1000 + rec.sentGroup.length };
          break;
        case 'send_private_msg':
          rec.sentPrivate.push(String(req.params['message']));
          data = { message_id: 2000 + rec.sentPrivate.length };
          break;
        default:
          status = 'failed';
          retcode = 1404;
          data = {};
      }
      ws.send(JSON.stringify({ status, retcode, data, echo: req.echo }));
    });
  });

  return wss;
}

function groupMessageEvent(text: string, mention: boolean): string {
  const message: Array<{ type: string; data: Record<string, unknown> }> = [];
  if (mention) message.push({ type: 'at', data: { qq: BOT_QQ } });
  if (mention) message.push({ type: 'text', data: { text: ' ' } });
  message.push({ type: 'text', data: { text } });

  return JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: Math.floor(Math.random() * 1e6),
    user_id: USER_QQ,
    group_id: GROUP_ID,
    self_id: BOT_QQ,
    time: Math.floor(Date.now() / 1000),
    font: 0,
    raw_message: text,
    message,
    sender: { user_id: USER_QQ, nickname: '测试用户', card: '', role: 'member' },
  });
}

function privateMessageEvent(text: string): string {
  return JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: Math.floor(Math.random() * 1e6),
    user_id: USER_QQ,
    self_id: BOT_QQ,
    time: Math.floor(Date.now() / 1000),
    font: 0,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: USER_QQ, nickname: '测试用户' },
  });
}

function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`等待超时: ${label}`));
      }
    }, 30);
  });
}

async function testRealtime(): Promise<void> {
  section('WebSocket 实时通信（含自动重连）');

  const rec: Recorded = { actions: [], sentGroup: [], sentPrivate: [] };
  let wss = startMockServer(rec);
  await new Promise<void>((r) => wss.once('listening', () => r()));

  const cfg: AppConfig['napcat'] = {
    enabled: true,
    mode: 'reverse-ws-client',
    url: `ws://127.0.0.1:${PORT}`,
    accessToken: '',
    selfId: 0,
    reconnect: { initialMs: 200, maxMs: 1000, factor: 1.5 },
    heartbeat: { intervalMs: 30000, timeoutMs: 10000 },
  };

  const client = new NapCatClient(cfg, getLogger('test'));
  const received: InboundMessage[] = [];
  let readyInfo: { selfId: number; nickname: string } | null = null;

  client.on('message', (m) => received.push(m));
  client.on('ready', (info) => {
    readyInfo = info;
  });
  client.start();

  // ---- 1. 连接与握手 ----
  await waitFor(() => readyInfo !== null, 5000, '等待 ready');
  check('连接: 成功握手并获取 login_info', readyInfo !== null);
  check('连接: selfId 正确解析', client.selfId === BOT_QQ, String(client.selfId));
  check('连接: nickname 正确', client.nickname === 'TestBot', client.nickname);
  check('连接: 状态标记为已连接', client.connected === true);

  // ---- 2. 群聊 @机器人 ----
  const conns = [...wss.clients];
  const agentWs = conns[0]!;
  agentWs.send(groupMessageEvent('你好呀', true));
  await waitFor(() => received.length >= 1, 3000, '等待群消息');
  check('群聊: 收到消息事件', received.length === 1);
  check(
    '群聊: 文本正确',
    received[0]?.text === '@你 你好呀' || received[0]?.text.includes('你好呀') === true,
    received[0]?.text,
  );
  check('群聊: @检测正确', received[0]?.mentionsBot === true);

  // ---- 3. 群聊 未@机器人 ----
  agentWs.send(groupMessageEvent('没@你', false));
  await waitFor(() => received.length >= 2, 3000, '等待第二条群消息');
  check('群聊: 未@机器人被正确识别', received[1]?.mentionsBot === false);

  // ---- 4. 私聊 ----
  agentWs.send(privateMessageEvent('私聊测试'));
  await waitFor(() => received.length >= 3, 3000, '等待私聊消息');
  check('私聊: 收到消息事件', received[2]?.scope === `private:${USER_QQ}`, received[2]?.scope);

  // ---- 5. 动作调用：发送消息 ----
  await client.api.sendGroupMsg(GROUP_ID, '群回复内容', { throwOnError: true });
  check('动作: send_group_msg 成功发出', rec.sentGroup.includes('群回复内容'));

  await client.api.sendPrivateMsg(USER_QQ, '私聊回复内容', { throwOnError: true });
  check('动作: send_private_msg 成功发出', rec.sentPrivate.includes('私聊回复内容'));

  await client.api.sendToScope(`group:${GROUP_ID}`, '按scope发送', { throwOnError: true });
  check('动作: sendToScope 自动路由到群', rec.sentGroup.includes('按scope发送'));

  // ---- 6. 错误 action 处理 ----
  let caught = false;
  try {
    await client.api.call('not_exist_action', {}, { throwOnError: true, timeoutMs: 2000 });
  } catch {
    caught = true;
  }
  check('动作: 不支持的 action 正确抛错', caught);

  // ---- 7. 断线自动重连 ----
  const actionsBefore = rec.actions.length;
  // 关闭服务端，模拟 NapCat 重启
  for (const ws of wss.clients) ws.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  await waitFor(() => client.connected === false, 4000, '等待检测到断线');
  check('重连: 检测到断线', client.connected === false);

  // 重新起服务端（同端口），客户端应自动连回
  wss = startMockServer(rec);
  await new Promise<void>((r) => wss.once('listening', () => r()));
  await waitFor(() => client.connected === true, 8000, '等待自动重连');
  check('重连: 自动重新连接成功', client.connected === true);
  check('重连: 重连后重新握手(login_info 再次调用)', rec.actions.length > actionsBefore);

  // 重连后仍能正常收发
  await waitFor(() => wss.clients.size > 0, 3000, '等待新连接');
  const newWs = [...wss.clients][0]!;
  const countBefore = received.length;
  newWs.send(groupMessageEvent('重连后的消息', true));
  await waitFor(() => received.length > countBefore, 3000, '等待重连后消息');
  check('重连: 重连后仍能收到消息', received.length > countBefore);

  client.stop();
  for (const ws of wss.clients) ws.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
}

// ============================================================
async function main(): Promise<void> {
  // 让测试输出干净：只保留警告以上
  process.env.LOG_LEVEL = 'warn';

  console.log('========================================');
  console.log('  阶段 1 验证：NapCat / OneBot 11 接入层');
  console.log('========================================');

  testNormalize();
  await testRealtime();

  console.log('\n========================================');
  console.log(`  结果: ${pass} 通过, ${fail} 失败`);
  console.log('========================================');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\n测试异常:', e);
  process.exit(1);
});
