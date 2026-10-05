import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateVectors, embedTexts, blobToVector } from '../src/llm/embedding.js';
import { makeFixture } from './helpers/chat-fixture.js';
import { SemanticIndex } from '../src/memory/semantic.js';
test('拒绝空、零、非有限、溢出、维度不一致向量和损坏 BLOB', () => {
  for (const vectors of [[], [[]], [[0,0]], [[NaN,1]], [[Infinity,1]], [[1e40,1]], [[1],[1,2]]]) assert.throws(() => validateVectors(vectors));
  assert.throws(() => blobToVector(Buffer.from([1]))); validateVectors([[1,2],[3,4]]);
});
test('OpenAI 按 index 还原输入顺序，重复索引失败', async () => {
  const original = globalThis.fetch;
  const args = { baseURL: 'http://mock', apiKey: '', protocol: 'openai' as const, model: 'emb', texts: ['a','b'] };
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ index: 1, embedding: [2,1] },{ index: 0, embedding: [1,2] }] }));
    assert.deepEqual((await embedTexts(args)).vectors, [[1,2],[2,1]]);
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [2,1] },{ index: 0, embedding: [1,2] }] }));
    assert.equal((await embedTexts(args)).ok, false);
  } finally { globalThis.fetch = original; }
});
test('补算期间改内容或切模型不会写入过时向量', async () => {
  const f = makeFixture({ name: 'index', expectedProvider: 'default' }, 'private:1');
  const manager: any = { embeddingReady: () => ({ ok: true }), resolveRole: () => ({ provider: 'p', model: 'm' }), getProvider: () => ({ baseURL: 'mock' }), embed: async () => { f.store.db.prepare('UPDATE memory_facts SET content=? WHERE id=?').run('新内容', id); return { ok:true, vectors:[[1,2]] }; } };
  const id = f.store.addFact({ userId:1, scope:'private:1', factType:'identity', content:'原内容' });
  try { const index = new SemanticIndex(f.store, manager, (f.pipeline as any).log); assert.equal(await index.backfill(1), 0); assert.equal(f.store.embeddingStats().total, 0); }
  finally { f.store.close(); }
});
test('索引保存内容哈希；内容修改后旧向量不可召回且需补算', () => {
 const f=makeFixture({name:'hash',expectedProvider:'default'},'private:1');
 try {
  const id=f.store.addFact({userId:1,scope:'private:1',factType:'identity',content:'旧事实'});f.store.saveFactEmbedding(id,[1,2],'model');
  assert.equal(f.store.searchFactsByVector(1,[1,2],{model:'model'}).length,1);
  assert.equal((f.store.db.prepare('SELECT content_hash FROM fact_embeddings WHERE fact_id=?').get(id) as any).content_hash.length,64);
  f.store.db.prepare('UPDATE memory_facts SET content=? WHERE id=?').run('新事实',id);
  assert.equal(f.store.searchFactsByVector(1,[1,2],{model:'model'}).length,0);assert.equal(f.store.countFactsMissingEmbedding(1,'model'),1);
 } finally {f.store.close();}
});
