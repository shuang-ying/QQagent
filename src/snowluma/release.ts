/** 官方发行包固定版本；不从管理接口接受任意下载 URL 或执行命令。 */
export const SNOWLUMA_VERSION = '1.14.22';
export const SNOWLUMA_SOURCE_COMMIT = '87527cb7641a5a42f8f0efb73cb066102e004dee';
export const SNOWLUMA_REPOSITORY = 'https://github.com/SnowLuma/SnowLuma';
export const SNOWLUMA_SOURCE = {
  name: 'source-v1.14.22.zip',
  url: 'https://codeload.github.com/SnowLuma/SnowLuma/zip/refs/tags/v1.14.22',
  sha256: 'f9c793dd6e003a583f08b646dd5145b21bed6622ed64ed486062b657566ba9bd',
};
const assets: Record<string, { name: string; sha256: string }> = {
  'win32-x64': { name: 'SnowLuma-v1.14.22-win-x64.zip', sha256: 'c8076ba2fbcdc19afeb8e8bf9b2956eaab3605e5fa4618c4db702749ae501681' },
  'linux-x64': { name: 'SnowLuma-v1.14.22-linux-x64.tar.gz', sha256: 'cd663a165caf012e08e6c303de69293fa7ccdc3950985b49bb254af9d4d91b98' },
  'linux-arm64': { name: 'SnowLuma-v1.14.22-linux-arm64.tar.gz', sha256: '203dac6497c3ee13fa5bb9d0f5d6e13cce3b33ebabb9e8089b36da2913c78e4b' },
};
export function releaseAsset(platform = process.platform, arch = process.arch) {
  const asset = assets[`${platform}-${arch}`];
  if (!asset) throw new Error(`SnowLuma 官方内置包暂不支持 ${platform}-${arch}`);
  return { ...asset, url: `${SNOWLUMA_REPOSITORY}/releases/download/v${SNOWLUMA_VERSION}/${asset.name}` };
}
