/**
 * APIハンドラ共通の部品（要件定義書 第8節）。
 * - JSONの読み取りとサイズ制限
 * - 連続送信対策（IP単位の簡易スロットル）
 * - エラー応答の統一。内部の詳細・鍵・予定の件名を顧客へ返さない。
 */

/** 顧客に見せてよい業務エラー。message がそのまま画面に出る。 */
export class PublicError extends Error {
  constructor(message, status = 400, code = 'bad_request') {
    super(message);
    this.name = 'PublicError';
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // 空き状況は常に最新を返す
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

const MAX_BODY_BYTES = 32 * 1024;

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new PublicError('送信内容が大きすぎます。', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new PublicError('送信内容を解釈できませんでした。', 400);
  }
}

/**
 * IP単位の簡易スロットル。サーバーレスのインスタンス内メモリなので完全ではないが、
 * 単純な連打・二重送信には有効。厳密な制限が必要になればSupabase側に移す。
 */
const hits = new Map();

export function throttle(req, { limit = 30, windowMs = 60000, key = '' } = {}) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const k = `${key}:${ip}`;
  const now = Date.now();

  const rec = hits.get(k);
  if (!rec || now - rec.start > windowMs) {
    hits.set(k, { start: now, count: 1 });
  } else {
    rec.count++;
    if (rec.count > limit) {
      throw new PublicError('短時間に操作が集中しています。少し時間をおいてお試しください。', 429, 'rate_limited');
    }
  }

  if (hits.size > 5000) hits.clear();
}

/**
 * ハンドラを包んで、例外を安全な応答に変換する。
 * PublicError 以外は内容を顧客へ出さず、サーバーログにだけ残す。
 */
export function handler(fn, { methods = ['POST'] } = {}) {
  return async (req, res) => {
    if (!methods.includes(req.method)) {
      return sendJson(res, 405, { ok: false, error: '許可されていないメソッドです。' });
    }
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof PublicError) {
        return sendJson(res, e.status, { ok: false, error: e.message, code: e.code });
      }
      // 経路・カレンダーの障害は「候補なし」と区別できるコードを付けて返す（第8節）
      const known = {
        CalendarError: { code: 'calendar_unavailable', msg: 'カレンダーの空き状況を確認できませんでした。' },
        RouteError: { code: 'route_unavailable', msg: '経路を調べられませんでした。' },
        StorageError: { code: 'storage_unavailable', msg: '申込を保存できませんでした。' }
      }[e?.name];

      console.error(`[api] ${e?.name || 'Error'}:`, e?.message);

      if (known) {
        return sendJson(res, 503, {
          ok: false, error: `${known.msg}お手数ですが、時間をおいてお試しいただくかLINEでご相談ください。`, code: known.code
        });
      }
      return sendJson(res, 500, { ok: false, error: '処理中に問題が発生しました。', code: 'internal' });
    }
  };
}

/** 受付番号。人が口頭・LINEで伝えられる長さにする。 */
export function makeReferenceCode(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const jst = new Date(now.getTime() + 9 * 3600000);
  const ymd = `${String(jst.getUTCFullYear()).slice(2)}${p(jst.getUTCMonth() + 1)}${p(jst.getUTCDate())}`;
  // 紛らわしい文字（0/O、1/I）を除いた英数字
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let tail = '';
  for (let i = 0; i < 4; i++) tail += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `DT-${ymd}-${tail}`;
}
