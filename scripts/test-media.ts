import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectImages, sniffMime } from '../src/llm/vision.js';
const png = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#ff0000' } }).png().toBuffer();
test('真实格式、哈希和缩放元数据', async () => {
  const got = await collectImages([{ type: 'image', data: { file: `base64://${png.toString('base64')}` } }], { maxDimension: 8 });
  assert.equal(got.errors.length, 0); assert.equal(got.images[0]?.width, 8); assert.equal(got.images[0]?.height, 4); assert.equal(got.images[0]?.hash?.length, 64);
  assert.equal(sniffMime(Buffer.from('hello')), '');
});
test('伪图片、过大 base64、尺寸炸弹拒绝', async () => {
  for (const opts of [{}, { maxBytes: 2 }, { maxPixels: 2 }]) {
    const file = opts.maxBytes || opts.maxPixels ? png : Buffer.from('<html>oops</html>');
    assert.equal((await collectImages([{ type: 'image', data: { file: `base64://${file.toString('base64')}` } }], opts)).images.length, 0);
  }
});
test('下载过程中超过上限停止读取', async () => {
  const original = globalThis.fetch; let cancelled = 0;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(ctrl) { ctrl.enqueue(new Uint8Array(100)); ctrl.enqueue(new Uint8Array(100)); }, cancel() { cancelled++; } }));
  try { const got = await collectImages([{ type: 'image', data: { url: 'https://synthetic.test/large' } }], { maxBytes: 150 }); assert.equal(got.images.length, 0); assert.ok(cancelled > 0); }
  finally { globalThis.fetch = original; }
});
test('URL 失效 get_image 回退，缓存复用', async () => {
  const original = globalThis.fetch; let recoveries = 0;
  globalThis.fetch = async () => new Response('', { status: 404 });
  try {
    const opts = { getImage: async () => { recoveries++; return { file: `base64://${png.toString('base64')}` }; } };
    const segs = [{ type: 'image', data: { file: 'qq-identifier', url: 'https://synthetic.test/expired' } }];
    assert.equal((await collectImages(segs, opts)).images.length, 1); assert.equal((await collectImages(segs, opts)).images.length, 1); assert.equal(recoveries, 1);
  } finally { globalThis.fetch = original; }
});
test('本地读取限定真实允许目录', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-media-')); const file = path.join(dir, 'a.png'); await fs.writeFile(file, png);
  try {
    const segs = [{ type: 'image', data: { file } }]; assert.equal((await collectImages(segs)).images.length, 0);
    assert.equal((await collectImages(segs, { allowedDirs: [dir] })).images.length, 1);
  } finally { await fs.unlink(file); await fs.rmdir(dir); }
});
