// 公開用のフォルダ dist/ を作る。
// サイトに必要なファイルだけをコピーする（db/ docs/ tests/ などは出さない）。
// 実行: node scripts/build.mjs
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist');

// 公開するもの（ここに足せば配信される）
const PUBLISH = [
  'index.html', 'apply.html', 'message.html', 'terms.html', 'tokushoho.html', 'privacy.html',
  'support.js', 'image-slot.js',
  'lib', 'uploads', 'assets',
  'robots.txt', 'sitemap.xml', 'site.webmanifest',
  '_headers'
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const name of PUBLISH) {
  const src = join(ROOT, name);
  if (!existsSync(src)) { console.warn('skip (not found):', name); continue; }
  cpSync(src, join(OUT, name), { recursive: true });
}
console.log('dist/ を作成しました');
