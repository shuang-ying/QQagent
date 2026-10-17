import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import pino from 'pino';
import { StickerLibrary, canonicalEmotion } from '../src/persona/stickers.js';
import { makeFixture } from './helpers/chat-fixture.js';
test('语境匹配、情绪别名和冷却排除，无匹配不随机', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-sticker-'));
  try {
    for (const file of ['happy_1.png', 'sad_1.png']) await fs.writeFile(path.join(dir, file), Buffer.from('fixture'));
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ entries: [
      { file: 'happy_1.png', tags: ['happy'], desc: '开心举杯', useWhen: '考试通过庆祝', emotions: ['happy'] },
      { file: 'sad_1.png', tags: ['sad'], desc: '难过哭泣', useWhen: '失落安慰', emotions: ['sad'] },
    ] }));
    const lib = new StickerLibrary(dir, pino({ level: 'silent' }));
    assert.equal(canonicalEmotion('happy'), 'joy'); assert.equal(lib.candidates('考试通过', 'neutral')[0]?.file, 'happy_1.png');
    assert.equal(lib.pickByEmotion('anger'), undefined); assert.equal(lib.candidates('讨论数据库', 'neutral').length, 0);
    assert.equal(lib.candidates('', 'joy', 5, { excludedFiles: ['happy_1.png'] }).length, 0);
    assert.equal(lib.describeCandidatesForPrompt(lib.candidates('', 'joy')).includes('sad'), false);
  } finally { for (const file of ['happy_1.png', 'sad_1.png', 'manifest.json']) await fs.unlink(path.join(dir, file)); await fs.rmdir(dir); }
});
test('失败表情投递不消耗冷却，成功才落使用记录', async () => {
  for (const ok of [false, true]) {
    for (const body of ['回复', '']) {
    const f = makeFixture({ name: 'usage', expectedProvider: 'default' }, 'private:1');
    try {
      f.cfg.sticker.enabled = true;
      const entry = { file: 'happy.png', absPath: 'synthetic', tags: ['happy'], desc: '开心', useWhen: '开心', emotions: ['joy'] };
      Object.assign(f.pipeline as any, { stickers: { available: true, candidates: () => [entry], describeCandidatesForPrompt: () => 'happy', list: () => [entry] } });
      (f.pipeline as any).dispatcher.snapshot = () => ({ thinkDelay: async () => 0,
        send: async () => ({ state: 'success', pieces: [{ state: 'success', content: '回复', messageId: 1 }] }), sendSticker: async () => ok });
      f.providers.streamChat = async () => ({ content: `${body}[表情:happy]`, model: 'm', provider: 'p', latencyMs: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
      const result = await f.pipeline.handle(f.msg, f.api);
      if (!body) assert.equal(result.replied, ok);
      assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM sticker_usage').get() as { n: number }).n, ok ? 1 : 0);
    } finally { f.store.close(); }
    }
  }
});
