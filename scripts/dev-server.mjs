/**
 * ローカル確認用の簡易サーバー。
 *
 * Vercel と同じように、静的ファイルを配信しつつ /api/* を関数として実行する。
 * `vercel dev` の代わりに、ログインなしで動作を確かめるために使う。
 *
 *   node scripts/dev-server.mjs            # .env の実際のキーを使う
 *   node scripts/dev-server.mjs --stub     # 外部サービスを偽装（キー不要）
 *
 * --stub では Google・NAVITIME・Supabase への通信を行わず、決まった応答を返す。
 * 画面の動作確認用であり、実際の空き状況ではない。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const STUB = process.argv.includes('--stub');

// --- .env の読み込み ---
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// --- 外部サービスの偽装 ---
if (STUB) {
  // 署名処理まで本番と同じ経路を通すため、使い捨ての鍵をその場で生成する
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.GOOGLE_SA_CLIENT_EMAIL = 'stub@example.iam.gserviceaccount.com';
  process.env.GOOGLE_SA_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
  process.env.GOOGLE_CALENDAR_IDS = 'primary';
  process.env.RAPIDAPI_KEY = 'stub';
  process.env.SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.GOOGLE_MAPS_API_KEY = 'stub';
  process.env.LINE_OA_ID = process.env.LINE_OA_ID || '@stub-oa';

  const jst = (d, min) => {
    const [y, m, dd] = d.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, dd) - 9 * 3600000 + min * 60000).toISOString();
  };
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const json = (o, s = 200) => ({ ok: s < 300, status: s, json: async () => o, text: async () => JSON.stringify(o) });

    if (u.includes('oauth2.googleapis.com')) return json({ access_token: 'stub', expires_in: 3600 });
    if (u.includes('freeBusy')) {
      // 動作確認しやすいよう、毎日12:00-13:00に予定を入れておく。
      // 照会区間は前日18:00(JST)から始まるので、timeMin をそのまま使うと前日になる。
      // 区間の中点＝対象日の正午(JST)から日付を取る。
      const body = JSON.parse(init.body);
      const mid = (Date.parse(body.timeMin) + Date.parse(body.timeMax)) / 2;
      const day = new Date(mid + 9 * 3600000).toISOString().slice(0, 10);
      return json({ calendars: { primary: { busy: [
        { start: jst(day, 12 * 60), end: jst(day, 13 * 60) },
        { start: jst(today, 0), end: jst(today, 1) }
      ] } } });
    }
    if (u.includes('route_transit')) {
      return json({ items: [{
        summary: { move: { time: u.includes('goal_time') ? 52 : 61, fare: { unit_0: 480 }, transit_count: 1 } },
        sections: [{ type: 'move', move: 'walk' }, { type: 'move', move: 'local_train' }]
      }] });
    }
    if (u.includes('maps.googleapis.com')) {
      return json({ status: 'OK', results: [
        { formatted_address: '東京都江東区有明2丁目2-22 有明テニスの森公園', geometry: { location: { lat: 35.6300, lng: 139.7900 } } },
        { formatted_address: '東京都立川市緑町 国営昭和記念公園', geometry: { location: { lat: 35.7050, lng: 139.4030 } } }
      ] });
    }
    if (u.includes('/rest/v1/applications')) {
      const method = (init && init.method) || 'GET';
      if (method === 'GET') return json([]);
      if (method === 'POST') { console.log('[stub] 保存:', JSON.parse(init.body).reference_code); return json([JSON.parse(init.body)]); }
      return json([]);
    }
    throw new Error('stub: 想定外のfetch ' + u);
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8'
};

const handlers = new Map();

async function getHandler(name) {
  if (!handlers.has(name)) {
    const file = join(ROOT, 'api', `${name}.mjs`);
    if (!existsSync(file)) return null;
    handlers.set(name, (await import(`file://${file}`)).default);
  }
  return handlers.get(name);
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice(5).replace(/\/$/, '');
    const h = await getHandler(name);
    if (!h) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: false, error: 'not found' }));
    }
    console.log(`${req.method} ${url.pathname}`);
    return h(req, res);
  }

  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = join(ROOT, decodeURIComponent(p));
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT}${STUB ? '  （--stub: 外部サービスは偽装）' : ''}`);
});
