/**
 * QQ Agent 启动入口
 *
 * 组装全部模块：
 *   配置 -> 日志 -> 存储 -> LLM -> 人格 -> 情绪 -> 上下文 -> 管线 -> NapCat
 */
import path from 'node:path';
import { loadConfig, PROJECT_ROOT } from './config/loader.js';
import { initLogger, getLogger } from './core/logger.js';
import { NapCatClient } from './napcat/client.js';
import { MemoryStore } from './memory/store.js';
import { ProviderManager } from './llm/manager.js';
import { PersonaManager } from './persona/manager.js';
import { TriggerPolicy } from './persona/trigger.js';
import { ProactiveSpeaker } from './persona/proactive.js';
import { EmotionAnalyzer } from './emotion/analyzer.js';
import { ContextBuilder } from './context/compressor.js';
import { MemoryRetriever } from './memory/retriever.js';
import { FactExtractor } from './memory/extractor.js';
import { setModelOverrides } from './llm/protocol.js';
import { ReplyPipeline } from './pipeline/reply.js';
import { ReplyDispatcher, pickPokeLine } from './pipeline/dispatch.js';
import { StickerLibrary } from './persona/stickers.js';
import { importQqFavorites, pushDescToQq } from './persona/stickerImport.js';
import { analyzeStickers } from './persona/stickerAnalyze.js';
import { CommandHandler } from './pipeline/commands.js';
import { stripMention, isQuietHour } from './persona/trigger.js';
import { createServer } from './server/api.js';
import { SemanticIndex } from './memory/semantic.js';
import { setConfigValues } from './config/writer.js';
import { validateSettings } from './config/settings.js';
import { loadPersonasFromDir, writePersona, deletePersonaFile } from './persona/files.js';
import fs from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { LlmRoleName, Persona } from './core/types.js';

async function main(): Promise<void> {
  // ==================== 1. 配置 ====================
  let loaded;
  try {
    loaded = loadConfig();
  } catch (e) {
    console.error(`\n${(e as Error).message}\n`);
    process.exit(1);
  }
  const { app, providers, personas, root } = loaded;

  // ==================== 2. 日志 ====================
  const log = initLogger({
    level: app.log.level,
    pretty: app.log.pretty,
    logDir: path.resolve(root, app.storage.logDir),
  });

  log.info('========================================');
  log.info('  🐱 QQ Agent 启动中');
  log.info('========================================');

  // ==================== 3. 存储 ====================
  const dbPath = path.resolve(root, app.storage.dbPath);
  const store = new MemoryStore(dbPath);
  const stats = store.stats();
  log.info(
    { db: dbPath, ...stats },
    `数据库已就绪（用户${stats.users} 消息${stats.messages} 记忆${stats.facts}）`,
  );

  // ==================== 4. LLM ====================
  // 先注入模型能力覆盖，后续所有推断都会用到
  setModelOverrides(app.llm.modelOverrides);

  // 传入 app.llm 引用，使面板对「模型用途」的修改可热生效
  const providersMgr = new ProviderManager(
    providers,
    getLogger('llm'),
    app.context.modelContextWindow,
    app.llm,
  );

  // 启动时后台预热模型发现，不阻塞启动
  void (async () => {
    for (const [key, p] of Object.entries(providers)) {
      if (!p.enabled) continue;
      try {
        const { models } = await providersMgr.ensureModels(key);
        log.info({ provider: key, models: models.length }, `模型列表就绪`);
      } catch (e) {
        log.warn({ provider: key, err: (e as Error).message }, '模型发现失败（可稍后在面板重试）');
      }
    }
  })();

  // ==================== 5. 人格 / 触发 ====================
  const personaMgr = new PersonaManager(personas, app, store, getLogger('persona'));
  const trigger = new TriggerPolicy(app.trigger, getLogger('trigger'));
  const proactive = new ProactiveSpeaker(app.proactive, store, getLogger('proactive'));

  log.info(
    { 人格: personas.map((p) => `${p.emoji}${p.name}`).join(' '), 默认: app.persona.default },
    `已加载 ${personas.length} 个人格`,
  );

  // ==================== 6. 情绪 ====================
  // 使用「模型用途 -> 情绪分析」指定的模型（未指定则继承默认）
  const emotionRole = providersMgr.resolveRole('emotion');
  const emotionAnalyzer = new EmotionAnalyzer(
    app.emotion.mode,
    app.emotion.enabled ? providersMgr : null,
    emotionRole.provider,
    emotionRole.model,
    getLogger('emotion'),
  );

  // ==================== 7. 上下文 / 记忆 ====================
  const contextBuilder = new ContextBuilder(app.context, app.memory, store, getLogger('context'));

  // 语义索引：只在配置了 embedding 模型后才真正工作
  const semantic = new SemanticIndex(store, providersMgr, getLogger('semantic'));

  const retriever = new MemoryRetriever(store, app.memory, getLogger('memory'), semantic);

  // extractor 始终创建：是否启用由 pipeline 每轮读 cfg.memory.factExtraction 决定，
  // 这样面板开关才能实时生效（否则启动时关掉就再也打不开了）
  const factsRole = providersMgr.resolveRole('facts');
  const extractor = new FactExtractor(
    providersMgr,
    factsRole.provider,
    factsRole.model,
    store,
    getLogger('facts'),
    app.memory.retrieval.shareableFactTypes,
  );

  /**
   * 把当前 cfg 同步到那些需要显式刷新配置的模块。
   * 面板修改「模型用途」或开关后调用。
   */
  function syncRuntime(): void {
    const emo = providersMgr.resolveRole('emotion');
    emotionAnalyzer.configure({
      mode: app.emotion.mode,
      manager: app.emotion.enabled ? providersMgr : null,
      providerKey: emo.provider,
      modelId: emo.model,
    });

    const fac = providersMgr.resolveRole('facts');
    extractor.configure({ providerKey: fac.provider, modelId: fac.model });

    log.debug(
      {
        emotion: `${emo.provider}/${emo.model || '(默认)'}`,
        facts: `${fac.provider}/${fac.model || '(默认)'}`,
        embedding: (() => {
          const e = providersMgr.resolveRole('embedding');
          return `${e.provider}/${e.model || '(未配置)'}`;
        })(),
      },
      '运行时配置已同步',
    );
  }

  // ==================== 8. 管线 ====================
  const dispatcher = new ReplyDispatcher(app.reply, getLogger('dispatch'));

  // 表情包库：**始终创建**，即使开关是关的。
  // 否则面板就没法在开启之前先导入收藏、跑 AI 识别 —— 而那些恰恰是开启前该做的准备。
  const stickerDir = path.resolve(root, app.sticker.dir);
  const stickerLog = getLogger('sticker');
  const stickers = new StickerLibrary(stickerDir, stickerLog, app.sticker.manifest);
  if (app.sticker.enabled) {
    if (stickers.available) {
      log.info(
        { dir: stickerDir, count: stickers.usable().length, tags: stickers.tags().length },
        `已启用表情包（${stickers.usable().length} 张、${stickers.tags().length} 个标签）`,
      );
    } else {
      log.warn({ dir: stickerDir }, '表情包已开启，但目录里没有可用图片（把 png/jpg/gif 放进去，文件名就是标签）');
    }
  }

  const pipeline = new ReplyPipeline(
    app,
    store,
    providersMgr,
    personaMgr,
    trigger,
    emotionAnalyzer,
    contextBuilder,
    retriever,
    extractor,
    dispatcher,
    stickers,
    getLogger('pipeline'),
  );
  const commands = new CommandHandler(app, store, personaMgr, getLogger('cmd'));

  // ==================== 9. NapCat ====================
  const napcat = new NapCatClient(app.napcat, getLogger('napcat'));

  napcat.on('ready', ({ selfId, nickname }) => {
    log.info({ selfId, nickname }, '🤖 机器人已上线');
  });
  napcat.on('reconnecting', ({ attempt, delayMs }) => {
    log.warn({ attempt, delayMs }, '等待重连 NapCat');
  });
  napcat.on('disconnected', ({ code, reason }) => {
    log.warn({ code, reason }, '与 NapCat 断开');
  });

  // ---- 戳一戳：戳回去，也可以说一句 ----
  napcat.on('poke', (ev) => {
    void (async () => {
      try {
        // 只回应"戳机器人"的；别人互相戳不掺和
        if (ev.targetId !== ev.selfId && ev.selfId !== 0) {
          log.debug({ scope: ev.scope, target: ev.targetId }, '不是戳机器人，忽略');
          return;
        }
        // 准入检查与消息一致
        const gate = trigger.checkUser(ev.userId);
        if (!gate.allowed) {
          log.debug({ userId: ev.userId, reason: gate.reason }, '忽略该用户的戳一戳');
          return;
        }
        if (ev.scopeType === 'group') {
          const g = trigger.checkGroup(ev.groupId);
          if (!g.allowed) return;
        }
        if (!app.reply.pokeBack && !app.reply.pokeReply) return;

        // 说一句人格口吻的话（不调 LLM，避免被刷爆；人格可自定义）
        const { persona } = personaMgr.resolve(ev.scope, ev.userId);
        const speak = app.reply.pokeReply ? pickPokeLine(persona) : undefined;

        const r = await dispatcher.reactToPoke(
          napcat.api,
          { scope: ev.scope, scopeType: ev.scopeType, userId: ev.userId },
          speak,
        );
        log.info({ scope: ev.scope, from: ev.userId, poked: r.poked, said: r.said }, '👆 回应了戳一戳');
      } catch (e) {
        log.warn({ err: (e as Error).message }, '处理戳一戳失败');
      }
    })();
  });

  napcat.on('message', (msg) => {
    void (async () => {
      try {
        // ---- 准入检查（黑白名单）----
        // 命令是在管线之前处理的，所以必须在这里也拦一次，
        // 否则被拉黑/不在白名单的人仍能用 /forget、/persona 等命令。
        const gate = trigger.checkUser(msg.userId);
        if (!gate.allowed) {
          log.debug({ userId: msg.userId, scope: msg.scope, reason: gate.reason }, '忽略该用户的消息');
          return;
        }

        // ---- 命令优先 ----
        if (msg.text.trim().startsWith('/')) {
          const cmdGate = trigger.canUseCommands(msg.userId);
          const personaGate = trigger.canSwitchPersona(msg.userId);
          const cmdResult = await commands.tryHandle(msg.text, {
            scope: msg.scope,
            scopeType: msg.scopeType,
            userId: msg.userId,
            senderName: msg.senderName,
            isAdmin: trigger.isAdmin(msg.userId),
            canUseCommands: cmdGate.allowed,
            canSwitchPersona: personaGate.allowed,
            ...(personaGate.reason ?? cmdGate.reason
              ? { denyReason: personaGate.reason ?? cmdGate.reason }
              : {}),
          });
          if (cmdResult.handled && cmdResult.reply) {
            // 命令也要先记录消息，保持上下文完整
            store.touchSession(
              msg.scope,
              msg.scopeType,
              msg.scopeType === 'group' ? (msg.groupId ?? 0) : msg.userId,
              msg.scopeType === 'group' ? `群${msg.groupId}` : msg.senderName,
            );
            store.touchUser(msg.userId, msg.senderName);
            store.addMessage({
              scope: msg.scope,
              userId: msg.userId,
              role: 'user',
              content: msg.text,
              messageId: msg.messageId,
              senderName: msg.senderName,
            });
            await napcat.api.sendToScope(msg.scope, cmdResult.reply, { throwOnError: true });
            log.info({ scope: msg.scope, cmd: msg.text.slice(0, 20) }, '✅ 已执行命令');
            return;
          }
        }

        // ---- 常规回复 ----
        const result = await pipeline.handle(msg, napcat.api);

        // ---- 主动发言评估（事件驱动，逐条消息）----
        // 放在 handle 之后：被 @ 的消息已经走了被动回复（result.replied=true），
        // 这时不该再叠加一次主动发言。只有"没回"的消息才需要考虑接话。
        if (
          msg.scopeType === 'group'
          && !result.replied
          && app.proactive.enabled
          && app.proactive.mode !== 'off'
        ) {
          const decision = proactive.evaluate(msg.scope, msg.groupId ?? 0, msg.mentionsBot);
          if (decision.speak) {
            log.info({ scope: msg.scope, reason: decision.reason }, '决定主动发言');
            await pipeline.handleProactive(
              msg.scope,
              'group',
              msg.groupId ?? 0,
              decision.reason,
              napcat.api,
            );
          } else {
            log.debug({ scope: msg.scope, reason: decision.reason }, '不主动发言');
          }
        }
      } catch (e) {
        log.error({ scope: msg.scope, err: (e as Error).message }, '处理消息时发生未捕获异常');
      }
    })();
  });

  napcat.start();

  // ==================== 9.5 管理面板 ====================
  const startedAt = Date.now();
  const server = createServer({
    cfg: app,
    store,
    providers: providersMgr,
    personas: personaMgr,
    log: getLogger('server'),
    runtime: () => ({
      napcatConnected: napcat.connected,
      selfId: napcat.selfId,
      nickname: napcat.nickname,
      uptimeMs: Date.now() - startedAt,
      startedAt,
    }),
    updateDefaultModel: (providerKey, modelId) => {
      // 手术式写回，保留 app.yaml 里的注释
      setConfigValues(path.resolve(root, 'config', 'app.yaml'), [
        [['llm', 'defaultProvider'], providerKey],
        [['llm', 'defaultModel'], modelId],
      ]);
      app.llm.defaultProvider = providerKey;
      app.llm.defaultModel = modelId;
      syncRuntime();
      log.info({ providerKey, modelId }, '默认模型已更新（已热生效）');
    },
    saveProvider: (key, config) => {
      // 写入 config/providers.local.yaml（在 .gitignore 中，适合存密钥）
      const localPath = path.resolve(root, 'config', 'providers.local.yaml');
      let doc: { providers: Record<string, unknown> };
      if (fs.existsSync(localPath)) {
        try {
          doc = parseYaml(fs.readFileSync(localPath, 'utf8')) as { providers: Record<string, unknown> };
          if (!doc || typeof doc !== 'object') doc = { providers: {} };
          if (!doc.providers || typeof doc.providers !== 'object') doc.providers = {};
        } catch {
          doc = { providers: {} };
        }
      } else {
        doc = { providers: {} };
      }
      doc.providers[key] = config;
      const yamlText = stringifyYaml(doc);
      fs.writeFileSync(localPath, yamlText, 'utf8');

      // 同时更新运行时
      providersMgr.addProvider(key, config);
      log.info({ key, baseURL: config.baseURL }, '供应商已保存');
    },
    deleteProvider: (key) => {
      // 从 providers.local.yaml 删除
      const localPath = path.resolve(root, 'config', 'providers.local.yaml');
      if (fs.existsSync(localPath)) {
        try {
          const doc = parseYaml(fs.readFileSync(localPath, 'utf8')) as { providers: Record<string, unknown> };
          if (doc?.providers && key in doc.providers) {
            delete doc.providers[key];
            const yamlText = stringifyYaml(doc);
            fs.writeFileSync(localPath, yamlText, 'utf8');
          }
        } catch {
          /* 文件损坏，忽略 */
        }
      }
      // 同时从 providers.yaml 删除（如果存在）
      const basePath = path.resolve(root, 'config', 'providers.yaml');
      if (fs.existsSync(basePath)) {
        try {
          const doc = parseYaml(fs.readFileSync(basePath, 'utf8')) as { providers: Record<string, unknown> };
          if (doc?.providers && key in doc.providers) {
            delete doc.providers[key];
            const yamlText = stringifyYaml(doc);
            // 保留头部注释：如果原文件有注释，用 Document 解析会丢失，所以只在没有注释时才覆盖
            // 安全做法：只在 local 文件不存在于 base 时才从 base 删除
            const rawBase = fs.readFileSync(basePath, 'utf8');
            if (!rawBase.trimStart().startsWith('#')) {
              fs.writeFileSync(basePath, yamlText, 'utf8');
            }
          }
        } catch {
          /* 忽略 */
        }
      }
      // 运行时删除
      providersMgr.removeProvider(key);
      log.info({ key }, '供应商已删除');
    },
    reloadPersonas: () => {
      // 真正重新读盘并热替换（面板增删改人格后调用）
      const list = loadPersonasFromDir(root);
      return personaMgr.reload(list);
    },

    /** 切换默认人格（写回 app.yaml + 热生效） */
    setDefaultPersona: (personaId) => {
      if (!personaMgr.has(personaId)) {
        throw new Error(`人格 ${personaId} 不存在`);
      }
      setConfigValues(path.resolve(root, 'config', 'app.yaml'), [
        [['persona', 'default'], personaId],
      ]);
      personaMgr.setDefault(personaId);
      log.info({ personaId }, '默认人格已切换');
    },

    /** 新增或更新一个人格文件 */
    savePersona: (persona: Persona, isNew: boolean) => {
      if (isNew && personaMgr.has(persona.id)) {
        throw new Error(`人格 id「${persona.id}」已存在，请换一个`);
      }
      if (!isNew && !personaMgr.has(persona.id)) {
        throw new Error(`人格 ${persona.id} 不存在`);
      }
      writePersona(root, persona);
      personaMgr.reload(loadPersonasFromDir(root));
      log.info({ id: persona.id, isNew }, isNew ? '已新增人格' : '已更新人格');
    },

    /** 删除一个人格 */
    deletePersona: (id: string) => {
      if (!personaMgr.has(id)) throw new Error(`人格 ${id} 不存在`);
      if (personaMgr.list().length <= 1) {
        throw new Error('至少要保留一个人格');
      }
      if (personaMgr.defaultId === id) {
        throw new Error('这是当前默认人格，请先把默认人格切换到其它人，再删除');
      }
      deletePersonaFile(root, id);
      const list = loadPersonasFromDir(root);
      personaMgr.reload(list);
      log.info({ id }, '已删除人格');
    },

    /**
     * 更新一组设置（功能开关 / 模型用途）。
     * 先校验再写盘，最后原地同步到运行时并刷新依赖模块。
     */
    updateSettings: (patch) => {
      const result = validateSettings(app, patch, providersMgr.providerKeys());
      if (!result.ok) throw new Error(result.error ?? '配置校验失败');
      if (result.entries.length === 0) return 0;

      setConfigValues(path.resolve(root, 'config', 'app.yaml'), result.entries);

      // 原地赋值，保证持有子对象引用的模块能立即看到变化
      for (const [pathArr, value] of result.entries) {
        let cur = app as unknown as Record<string, unknown>;
        for (let i = 0; i < pathArr.length - 1; i++) {
          cur = cur[pathArr[i]!] as Record<string, unknown>;
        }
        cur[pathArr[pathArr.length - 1]!] = value;
      }

      syncRuntime();
      log.info({ changed: result.entries.map(([p, v]) => `${p.join('.')}=${String(v)}`) }, '配置已更新并热生效');
      return result.entries.length;
    },

    /** 应用访问控制改动（条目已由 validateAccess 校验） */
    updateAccess: (entries) => {
      if (entries.length === 0) return 0;
      setConfigValues(path.resolve(root, 'config', 'app.yaml'), entries);

      // 原地赋值，保证 TriggerPolicy 持有的 cfg.trigger 引用立即看到新值
      for (const [pathArr, value] of entries) {
        let cur = app as unknown as Record<string, unknown>;
        for (let i = 0; i < pathArr.length - 1; i++) {
          cur = cur[pathArr[i]!] as Record<string, unknown>;
        }
        cur[pathArr[pathArr.length - 1]!] = value;
      }

      log.info(
        {
          用户白名单: app.trigger.allowUsers.length,
          用户黑名单: app.trigger.denyUsers.length,
          群白名单: app.trigger.group.enabledGroups.length,
          管理员: app.trigger.admins.length,
        },
        '访问控制已更新并立即生效',
      );
      return entries.length;
    },

    /** 测试 embedding 是否可用（面板「向量化」用途的测试按钮） */
    testEmbedding: async (providerKey, model) => {
      const res = await providersMgr.embed(['测试文本 test'], { providerKey, modelId: model });
      return {
        ok: res.ok,
        dim: res.vectors[0]?.length ?? 0,
        latencyMs: res.latencyMs,
        ...(res.error ? { error: res.error } : {}),
      };
    },

    /** 向量索引统计 */
    embeddingStats: () => store.embeddingStats(),

    /** 当前各模块实际生效的配置（面板展示用） */
    runtimeDetail: () => ({
      emotion: emotionAnalyzer.describe(),
      facts: extractor.describe(),
      roles: providersMgr.listRoles(),
      semanticReady: semantic.isConfigured(),
      vision: providersMgr.visionHealth(),
    }),

    // ==================== 表情包管理 ====================
    stickers: () => stickers,

    reloadStickers: () => stickers.reload(),

    /** 从 QQ 收藏导入：拉列表 → 下载落盘 → 写 manifest */
    importQqStickers: (limit) =>
      importQqFavorites(napcat.api, stickers, stickerLog, { limit }),

    /**
     * 用视觉模型识别表情包含义。
     * 先确认视觉模型可用 —— 否则会白跑一遍，用户只看到"全部失败"却不知为什么。
     */
    analyzeStickers: async (opts) => {
      const health = providersMgr.visionHealth();
      if (!health.ok) {
        throw new Error(
          `视觉模型不可用（${health.provider}/${health.model}）${health.warning ? `：${health.warning}` : ''}。` +
            '请到「模型用途 → 图片理解」选一个支持看图的模型。',
        );
      }
      return analyzeStickers(providersMgr, stickers, stickerLog, opts);
    },

    /** 把 AI 描述回写进 QQ 自带的收藏表情描述 */
    pushStickerDesc: async () => {
      const items = stickers
        .list()
        .filter((s) => s.source === 'qq' && !s.missing && s.desc.trim() && s.resId && s.md5)
        .map((s) => ({
          emojiId: s.emojiId,
          resId: s.resId,
          md5: s.md5,
          desc: s.desc,
        }));
      if (items.length === 0) {
        return { ok: 0, failed: 0 };
      }
      return pushDescToQq(napcat.api, items, stickerLog);
    },
  });
  server.start();

  // ==================== 10. 主动发言 ====================
  // 不再用定时轮询：策略里的「每几句话」必须在消息到达的那一刻判定，
  // 轮询既数不准条数，反应也慢（最坏要等一个轮询周期）。
  // 评估入口已经挂在 message 事件里（见上文）。
  {
    const p = app.proactive;
    if (p.enabled && p.mode !== 'off') {
      log.info(
        { mode: p.mode, everyNMessages: p.everyNMessages, probability: p.probability, relevanceProbability: p.relevanceProbability },
        `主动发言已启用（${p.mode}）：每 ${p.everyNMessages} 条消息基础概率 ${p.probability}，话题相关概率 ${p.relevanceProbability}`,
      );
    }
  }

  // ==================== 11. 就绪信息 ====================
  log.info('========================================');
  log.info('  ✅ QQ Agent 已就绪');
  log.info('========================================');
  log.info(`   NapCat      : ${app.napcat.url}`);
  log.info(`   默认模型    : ${app.llm.defaultProvider || '(未配置)'}${app.llm.defaultModel ? '/' + app.llm.defaultModel : ''}`);
  log.info(`   默认人格    : ${app.persona.default}`);
  log.info(`   情绪提取    : ${app.emotion.enabled ? app.emotion.mode : '关闭'}`);
  log.info(`   事实抽取    : ${app.memory.factExtraction ? '开启' : '关闭'}`);
  log.info(`   主动发言    : ${app.proactive.enabled ? app.proactive.mode : '关闭'}`);
  log.info(`   数据库      : ${dbPath}`);
  log.info(`   日志        : ${path.resolve(root, app.storage.logDir)}`);
  log.info(`   管理面板    : http://${app.server.host}:${app.server.port}`);
  log.info('');
  log.info('   在 QQ 里 @机器人 或私聊即可对话');
  log.info('   发送 /help 查看可用命令');
  log.info('');

  // ==================== 12. 优雅退出 ====================
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, '正在关闭 ...');
    server.stop();
    napcat.stop();
    setTimeout(() => {
      try {
        store.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
    }, 400);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 未捕获异常不应让机器人静默死掉
  process.on('uncaughtException', (err) => {
    log.error({ err: err.message, stack: err.stack?.split('\n').slice(0, 5).join('\n') }, '未捕获异常');
  });
  process.on('unhandledRejection', (reason) => {
    log.error({ reason: String(reason) }, '未处理的 Promise 拒绝');
  });

  void PROJECT_ROOT;
  void stripMention;
}

main().catch((e) => {
  console.error('启动失败:', e);
  try {
    getLogger('main').fatal({ err: e }, '启动失败');
  } catch {
    /* ignore */
  }
  process.exit(1);
});
