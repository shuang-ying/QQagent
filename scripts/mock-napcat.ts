/**
 * Mock NapCat / OneBot 11 服务端
 *
 * 用途：在没有真实 QQ、不打扰你的账号的前提下，完整验证接入层。
 * 行为与 NapCat 的 WS 服务端一致：
 *   - 接受 Agent 反向连入
 *   - 支持 action 调用并回 echo 响应（get_login_info / send_group_msg 等）
 *   - 可主动推送消息事件（模拟别人发消息）
 *
 * 用法：
 *   终端A: npm run mock:napcat
 *   终端B: npm run dev
 *   然后在 mock 终端输入文字并回车，即模拟"用户发来消息"
 */
import { WebSocketServer, WebSocket } from 'ws';
import net from 'node:net';

const REQUESTED_PORT = Number(process.env.MOCK_PORT ?? 3001);
const BOT_QQ = Number(process.env.MOCK_BOT_QQ ?? 10001);
const USER_QQ = Number(process.env.MOCK_USER_QQ ?? 20002);
const GROUP_ID = Number(process.env.MOCK_GROUP_ID ?? 30003);

/**
 * 检查端口是否已被占用。
 *
 * 重要：Windows 上 127.0.0.1 与 0.0.0.0 可以同时绑定同一端口，
 * 所以「绑定成功」并不代表端口是独占的 —— 真实 NapCat 可能正listen在
 * 同一端口上，导致 Agent 连到了真实 NapCat 而不是本 mock。
 * 因此这里主动探测 127.0.0.1，发现占用就换端口并大声提示。
 */
function isPortBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickPort(): Promise<number> {
  for (let p = REQUESTED_PORT; p < REQUESTED_PORT + 10; p++) {
    if (!(await isPortBusy(p))) return p;
    console.log(
      `\n  ⚠ 端口 ${p} 已被占用（可能是真实 NapCat，或已在运行另一个 mock）。`,
    );
  }
  console.error(`\n  ❌ ${REQUESTED_PORT}~${REQUESTED_PORT + 9} 全部被占用，无法启动 mock。`);
  process.exit(1);
}

const PORT = await pickPort();
if (PORT !== REQUESTED_PORT) {
  console.log(`  ↳ 自动改用端口 ${PORT}`);
  console.log(`  ↳ 请把 config/app.yaml 的 napcat.url 改为 ws://127.0.0.1:${PORT}`);
  console.log(`     或设置环境变量 MOCK_PORT=${PORT} 后重启 mock。\n`);
}

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });
const clients = new Set<WebSocket>();

function log(...args: unknown[]): void {
  console.log(`[mock-napcat ${new Date().toLocaleTimeString()}]`, ...args);
}

wss.on('listening', () => {
  log(`✅ Mock OneBot 服务端已启动: ws://127.0.0.1:${PORT}`);
  log(`   机器人QQ=${BOT_QQ}  测试用户QQ=${USER_QQ}  测试群=${GROUP_ID}`);
  log('');
  log('   直接输入文字回车 → 模拟该用户在【群聊】@机器人 发消息');
  log('   命令:');
  log('     /p <文字>   模拟【私聊】消息');
  log('     /g <文字>   模拟【群聊】消息（不@机器人）');
  log('     /a <文字>   模拟【群聊】@机器人 消息');
  log('     /raw <json> 直接推送自定义事件 JSON');
  log('     /list       查看已连接的 Agent');
  log('');
});

wss.on('connection', (ws, req) => {
  clients.add(ws);
  log(`🔌 Agent 已连接（来自 ${req.socket.remoteAddress}），当前连接数 ${clients.size}`);

  const token = req.headers['authorization'];
  if (token) log(`   带 Access Token: ${String(token).slice(0, 20)}...`);

  // 连接后立刻推送一个生命周期事件，模拟真实 NapCat
  ws.send(
    JSON.stringify({
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: 'connect',
      time: Math.floor(Date.now() / 1000),
      self_id: BOT_QQ,
    }),
  );

  ws.on('message', (raw) => {
    let req2: { action?: string; params?: Record<string, unknown>; echo?: unknown };
    try {
      req2 = JSON.parse(raw.toString());
    } catch {
      log('⚠ 收到非 JSON:', raw.toString().slice(0, 120));
      return;
    }

    const { action, params = {}, echo } = req2;
    log(`📥 action=${action} params=${JSON.stringify(params).slice(0, 160)}`);

    let data: unknown = {};
    let status: 'ok' | 'failed' = 'ok';
    let retcode = 0;
    let wording = '';

    switch (action) {
      case 'get_login_info':
        data = { user_id: BOT_QQ, nickname: 'MockBot' };
        break;
      case 'get_status':
        data = { online: true, good: true };
        break;
      case 'get_version_info':
        data = { app_name: 'mock-napcat', app_version: '1.0.0', protocol_version: 'v11' };
        break;
      case 'get_group_list':
        data = [{ group_id: GROUP_ID, group_name: '测试群', member_count: 3 }];
        break;
      case 'get_group_info':
        data = { group_id: params['group_id'], group_name: '测试群', member_count: 3, max_member_count: 500 };
        break;
      case 'get_group_member_info':
        data = { user_id: params['user_id'], nickname: '测试用户', card: '', role: 'member' };
        break;
      case 'get_friend_list':
        data = [{ user_id: USER_QQ, nickname: '测试用户', remark: '' }];
        break;
      case 'send_private_msg':
        log(`📤 【私聊→${params['user_id']}】${String(params['message']).slice(0, 200)}`);
        data = { message_id: Math.floor(Math.random() * 100000) };
        break;
      case 'send_group_msg':
        log(`📤 【群${params['group_id']}】${String(params['message']).slice(0, 200)}`);
        data = { message_id: Math.floor(Math.random() * 100000) };
        break;
      case 'delete_msg':
        log(`🗑 撤回消息 ${params['message_id']}`);
        data = {};
        break;
      case 'set_msg_emoji_like':
        data = {};
        break;
      default:
        status = 'failed';
        retcode = 1404;
        wording = `不支持的 action: ${action}`;
        data = {};
        log(`⚠ 未知 action: ${action}`);
    }

    ws.send(JSON.stringify({ status, retcode, data, echo, wording }));
  });

  ws.on('close', () => {
    clients.delete(ws);
    log(`❌ Agent 断开连接，剩余连接数 ${clients.size}`);
  });

  ws.on('error', (e) => log('Agent 连接错误:', e.message));
});

// ==================== 推送消息事件 ====================

interface PushOptions {
  text: string;
  scopeType: 'private' | 'group';
  mention?: boolean;
}

function pushMessage({ text, scopeType, mention = false }: PushOptions): void {
  if (clients.size === 0) {
    log('⚠ 没有 Agent 连接，消息未推送。请先启动 npm run dev');
    return;
  }

  const segments: Array<{ type: string; data: Record<string, unknown> }> = [];
  if (mention) segments.push({ type: 'at', data: { qq: BOT_QQ, name: 'MockBot' } });
  if (mention) segments.push({ type: 'text', data: { text: ' ' } });
  segments.push({ type: 'text', data: { text } });

  const event: Record<string, unknown> = {
    post_type: 'message',
    message_type: scopeType,
    sub_type: scopeType === 'private' ? 'friend' : 'normal',
    message_id: Math.floor(Math.random() * 1e6),
    user_id: USER_QQ,
    message: segments,
    raw_message: text,
    font: 0,
    self_id: BOT_QQ,
    time: Math.floor(Date.now() / 1000),
    sender: {
      user_id: USER_QQ,
      nickname: '测试用户',
      card: scopeType === 'group' ? '群里的测试用户' : '',
      role: 'member',
    },
  };
  if (scopeType === 'group') event['group_id'] = GROUP_ID;

  const payload = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
  const label = scopeType === 'group' ? `群聊${mention ? '@机器人' : ''}` : '私聊';
  log(`📨 已推送【${label}】: ${text}`);
}

// ==================== 交互式输入 ====================

function setupInput(): void {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      const input = line.trim();
      if (!input) continue;

      if (input === '/list') {
        log(`当前连接数: ${clients.size}`);
        continue;
      }
      if (input === '/quit' || input === '/exit') {
        log('退出 mock 服务端');
        process.exit(0);
      }
      if (input.startsWith('/raw ')) {
        const json = input.slice(5);
        try {
          JSON.parse(json);
          for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(json);
          log('📨 已推送自定义事件');
        } catch (e) {
          log('⚠ JSON 无效:', (e as Error).message);
        }
        continue;
      }
      if (input.startsWith('/p ')) {
        pushMessage({ text: input.slice(3), scopeType: 'private', mention: false });
        continue;
      }
      if (input.startsWith('/g ')) {
        pushMessage({ text: input.slice(3), scopeType: 'group', mention: false });
        continue;
      }
      if (input.startsWith('/a ')) {
        pushMessage({ text: input.slice(3), scopeType: 'group', mention: true });
        continue;
      }

      // 默认：群聊 @机器人
      pushMessage({ text: input, scopeType: 'group', mention: true });
    }
  });
}

setupInput();

process.on('SIGINT', () => {
  log('关闭 mock 服务端');
  wss.close();
  process.exit(0);
});
