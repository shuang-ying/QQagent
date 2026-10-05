import assert from 'node:assert/strict';
import test from 'node:test';
import { contentToText } from '../src/core/types.js';
import { makeFixture, scenarios } from './helpers/chat-fixture.js';

for (const mode of ['private', 'group', 'proactive'] as const) {
  for (const scenario of scenarios) {
    await test(`${mode}: ${scenario.name}`, async () => {
      const f = makeFixture(scenario, mode === 'private' ? 'private:1' : 'group:123');
      try {
        if (mode === 'proactive') {
          const recorded = await f.pipeline.handle({ ...f.msg, mentionsBot: false }, f.api);
          assert.equal(recorded.replied, false);
        }
        const result = mode === 'proactive'
          ? await f.pipeline.handleProactive(f.msg.scope, 'group', 123, '合成主动触发', f.api)
          : await f.pipeline.handle(f.msg, f.api);
        assert.equal(result.replied, true, result.reason);
        assert.equal(f.calls.length, 1);
        const call = f.calls[0]!;
        assert.equal(call.provider, scenario.expectedProvider);
        assert.equal(call.model, scenario.expectedModel);
        assert.ok(f.roles.includes('chat'));
        assert.equal(f.sends(), 1);
        const images = call.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image') : []);
        assert.equal(images.length, scenario.expectedImages ?? 0);
        const actualModel = scenario.expectedModel || `${scenario.expectedProvider}-first`;
        const prompt = call.messages.filter((m) => m.role === 'system').map((m) => contentToText(m.content)).join('\n');
        assert.ok(prompt.includes(actualModel), 'self-info must describe selected model');
        if (scenario.expectVisionNote) assert.ok(prompt.includes('看不到这张图'));
        const replyLog = f.logs.find((entry) => entry.msg === '✅ 已回复');
        assert.equal(replyLog?.provider, scenario.expectedProvider);
        assert.equal(replyLog?.model, actualModel);
      } finally {
        f.store.close();
      }
    });
  }
}

await test('chat role hot update applies on the next turn', async () => {
  const f = makeFixture({ name: 'hot update', expectedProvider: 'default' }, 'private:1');
  try {
    assert.equal((await f.pipeline.handle(f.msg, f.api)).replied, true);
    f.cfg.llm.roles.chat.provider = 'updated';
    f.cfg.llm.roles.chat.model = 'updated-model';
    assert.equal((await f.pipeline.handle({ ...f.msg, messageId: 11, text: '下一条' }, f.api)).replied, true);
    assert.deepEqual(f.calls.map(({ provider, model }) => ({ provider, model })), [
      { provider: 'default', model: 'default-model' },
      { provider: 'updated', model: 'updated-model' },
    ]);
  } finally {
    f.store.close();
  }
});
