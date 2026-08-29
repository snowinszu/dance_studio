// 校验一个已发布的 GitHub Release：附件齐全、非草稿、每个大小 > 0，
// 且下载下来的 portable .exe 的 SHA-256 与 SHA256SUMS.txt 一致。
//
// 用法：node scripts/verify-release.mjs <tag> <downloadDir>
//   <tag>          形如 v0.0.0-ci.42
//   <downloadDir>  workflow 里已用 `gh release download` 落好三个附件的目录
//
// Release 元数据通过 `gh api` 拉取（gh 负责鉴权 / 公私仓）。
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const [tag, dir] = process.argv.slice(2);
if (!tag || !dir) {
  console.error('用法：node scripts/verify-release.mjs <tag> <downloadDir>');
  process.exit(2);
}

const repo = process.env.GITHUB_REPOSITORY;
if (!repo) {
  console.error('缺少 GITHUB_REPOSITORY 环境变量');
  process.exit(2);
}

const version = tag.replace(/^v/, '');
const expected = [
  'SHA256SUMS.txt',
  `dance-studio-Portable-${version}-x64.exe`,
  `dance-studio-Setup-${version}-x64.exe`,
].sort();

const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exitCode = 1;
};

// ---- 1. 通过 gh api 拉 Release 元数据 ----
let release;
try {
  const raw = execFileSync('gh', ['api', `repos/${repo}/releases/tags/${tag}`], {
    encoding: 'utf8',
  });
  release = JSON.parse(raw);
} catch (e) {
  console.error(`::error::拉取 Release ${tag} 失败：${e.message}`);
  process.exit(1);
}

if (release.draft) fail(`Release ${tag} 是草稿（应为已发布）`);

const names = (release.assets ?? []).map((a) => a.name).sort();
if (JSON.stringify(names) !== JSON.stringify(expected)) {
  fail(`附件不匹配。期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(names)}`);
}
for (const a of release.assets ?? []) {
  if (!(a.size > 0)) fail(`附件 ${a.name} 大小为 ${a.size}（应 > 0）`);
}

// ---- 2. 校验下载文件的 SHA-256 与清单一致 ----
const sumsPath = join(dir, 'SHA256SUMS.txt');
const portableName = `dance-studio-Portable-${version}-x64.exe`;
const portablePath = join(dir, portableName);

if (!existsSync(sumsPath)) fail(`下载目录缺少 SHA256SUMS.txt：${sumsPath}`);
if (!existsSync(portablePath)) fail(`下载目录缺少 ${portableName}`);

if (process.exitCode === 1) {
  console.error('前置校验失败，跳过校验和比对');
  process.exit(1);
}

const sums = Object.fromEntries(
  readFileSync(sumsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, ...rest] = line.trim().split(/\s+/);
      return [rest.join(' '), hash.toLowerCase()];
    }),
);

const actual = createHash('sha256').update(readFileSync(portablePath)).digest('hex');
const wanted = sums[portableName];

if (!wanted) {
  fail(`SHA256SUMS.txt 里没有 ${portableName} 这一行`);
} else if (wanted !== actual) {
  fail(`${portableName} 校验和不一致：清单 ${wanted}，实算 ${actual}`);
}

if (process.exitCode === 1) process.exit(1);
console.log(`✓ Release ${tag} 附件齐全、非草稿、大小均 > 0；${portableName} SHA-256 与清单一致`);
