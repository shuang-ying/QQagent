import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import type { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import type { SnowLumaController } from './controller.js';

const COOKIE = 'qq_agent_snowluma_session';
/** 独立源代理保持上游绝对资源/API路径；不改写官方前端或上游鉴权。 */
export class SnowLumaGateway {
  private server?: http.Server;
  private opening?: Promise<number>;
  private sockets = new Set<Socket>();
  private sessions = new Map<string, { origin: string; expires: number }>();
  private port = 0;
  constructor(private controller: SnowLumaController, private host: string) {}
  async session(origin: string) {
    if (!this.opening) {
      this.server = http.createServer((request, response) => this.proxy(request, response));
      this.server.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
      this.opening = new Promise<number>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(0, this.host, () => {
          this.port = (this.server!.address() as { port: number }).port; resolve(this.port);
        });
      }).catch(error => { this.opening = undefined; throw error; });
    }
    const port = await this.opening;
    for (const [key, session] of this.sessions) if (session.expires < Date.now()) this.sessions.delete(key);
    if (this.sessions.size >= 50) this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { origin, expires: Date.now() + 8 * 3600000 });
    return { token, port };
  }
  private proxy(request: http.IncomingMessage, response: http.ServerResponse) {
    const deny = (status: number, message: string) => { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end(message); };
    const token = (request.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    const session = token ? this.sessions.get(token) : undefined;
    if (!session || session.expires < Date.now()) return deny(401, '请在 Agent 的 SnowLuma 页面刷新内置界面');
    const origin = request.headers.origin;
    const gatewayOrigin = new URL(session.origin); gatewayOrigin.port = String(this.port);
    if (origin && origin !== session.origin && origin !== gatewayOrigin.origin) return deny(403, '不允许跨站请求');
    if (this.controller.status().phase !== 'running') return deny(503, 'SnowLuma 尚未就绪，请查看终端日志');
    if (!request.url?.startsWith('/')) return deny(400, '非法代理路径');
    const target = new URL(this.controller.backendUrl);
    const headers: http.IncomingHttpHeaders = { ...request.headers, host: target.host };
    delete headers['x-forwarded-for']; delete headers['x-forwarded-host']; delete headers['x-forwarded-proto']; delete headers['x-real-ip'];
    headers.cookie = (headers.cookie ?? '').split(';').filter(value => !value.trim().startsWith(COOKIE + '=')).join(';');
    if (headers.origin) headers.origin = target.origin;
    if (headers.referer) headers.referer = target.origin + '/';
    const upstream = http.request({ hostname: target.hostname, port: target.port, path: request.url, method: request.method, headers }, received => {
      upstream.setTimeout(0); // 原页面使用 SSE，不能用普通短请求超时截断日志/状态流。
      const out = { ...received.headers };
      delete out['x-frame-options'];
      const csp = String(out['content-security-policy'] ?? '').replace(/frame-ancestors[^;]*(;|$)/g, '');
      out['content-security-policy'] = csp + `; frame-ancestors ${session.origin};`;
      out['cache-control'] = 'no-store';
      response.writeHead(received.statusCode ?? 502, out); received.pipe(response);
      received.on('error', () => response.destroy());
    });
    upstream.setTimeout(15000, () => upstream.destroy(new Error('SnowLuma 代理响应超时')));
    upstream.on('error', () => { if (!response.headersSent) deny(502, 'SnowLuma 暂时不可访问'); else response.destroy(); });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  }
  async close() {
    await this.opening?.catch(() => undefined);
    this.sessions.clear();
    for (const socket of this.sockets) socket.destroy();
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.server = undefined; this.opening = undefined; this.port = 0;
  }
}

export function registerSnowLumaRoutes(app: Hono, controller: SnowLumaController | undefined,
  config: { host: string; onebot: () => { mode: string; url: string } }) {
  const gateway = controller ? new SnowLumaGateway(controller, config.host) : undefined;
  app.use('/api/snowluma/*', async (c, next) => {
    if (!controller) return c.json({ ok: false, error: '当前服务未配置 SnowLuma 管理器' }, 503);
    const origin = c.req.header('origin');
    if (c.req.method !== 'GET' && origin && origin !== new URL(c.req.url).origin)
      return c.json({ ok: false, error: '不允许跨站控制 SnowLuma' }, 403);
    c.header('Cache-Control', 'no-store');
    return next();
  });
  app.get('/api/snowluma/status', c => c.json({ ok: true, ...controller!.status(), onebot: config.onebot() }));
  app.get('/api/snowluma/terminal', c => {
    const after = Number(c.req.query('after') ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) return c.json({ ok: false, error: '非法日志游标' }, 400);
    return c.json({ ok: true, ...controller!.terminal(after) });
  });
  app.post('/api/snowluma/install', c => {
    try { return c.json({ ok: true, ...controller!.install() }, 202); }
    catch (error) { return c.json({ ok: false, error: (error as Error).message }, 409); }
  });
  app.post('/api/snowluma/start', async c => {
    try { return c.json({ ok: true, ...await controller!.start() }); }
    catch (error) { return c.json({ ok: false, error: (error as Error).message }, 409); }
  });
  app.post('/api/snowluma/stop', async c => {
    try { await controller!.stop(); return c.json({ ok: true, ...controller!.status() }); }
    catch (error) { return c.json({ ok: false, error: (error as Error).message }, 409); }
  });
  app.post('/api/snowluma/session', async c => {
    const session = await gateway!.session(new URL(c.req.url).origin);
    setCookie(c, COOKIE, session.token, { path: '/', httpOnly: true, sameSite: 'Strict', maxAge: 8 * 3600,
      secure: new URL(c.req.url).protocol === 'https:' });
    return c.json({ ok: true, port: session.port });
  });
  return async () => { await gateway?.close(); await controller?.shutdown(); };
}
