/**
 * Googleカレンダーの空き時間照会（要件定義書 第4節・第8節）。
 *
 * - free/busy 照会のみを使う。予定の件名・参加者・場所は取得しない。
 * - 書き込みAPIは一切呼ばない（受入条件「Googleカレンダーへの書き込みを行わない」）。
 * - 認証はサービスアカウント。運営者はカレンダーを「予定の表示（空き時間情報のみ）」で
 *   そのサービスアカウントに共有する。顧客に運営者のGoogleログインを求めない。
 * - 取得に失敗したら必ず例外を投げる。空配列を返して「空いている」と誤解させない。
 *
 * 依存パッケージなし（node:crypto でJWTに署名する）。
 */

import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';
/** 空き時間情報だけを読む最小スコープ。予定の詳細は取得できない。 */
const SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';

/** カレンダー認証・取得の失敗。呼び出し側が「候補なし」と区別するために専用の型にする。 */
export class CalendarError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'CalendarError';
    this.cause = cause;
  }
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * サービスアカウントの秘密鍵でJWTを作り、アクセストークンと交換する。
 * 秘密鍵は環境変数からのみ読む。ログにも応答にも出さない。
 */
let cachedToken = null;

async function getAccessToken(env) {
  const clientEmail = env.GOOGLE_SA_CLIENT_EMAIL;
  // Vercelの環境変数では改行が \n として入るため元に戻す
  const privateKey = (env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    throw new CalendarError('Googleサービスアカウントが設定されていません。');
  }

  // 期限に60秒の余裕を見て使い回す
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
    return cachedToken.token;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));

  let signature;
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claim}`);
    signature = base64url(signer.sign(privateKey));
  } catch (e) {
    // 鍵の中身はエラーメッセージに含めない
    throw new CalendarError('サービスアカウントの秘密鍵が不正です。', e);
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`
    })
  });

  if (!res.ok) {
    throw new CalendarError(`Googleの認証に失敗しました (HTTP ${res.status})`);
  }

  const json = await res.json();
  if (!json.access_token) throw new CalendarError('Googleのアクセストークンを取得できませんでした。');

  cachedToken = { token: json.access_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

/**
 * 指定区間のbusyを取得する。
 *
 * 第4節のとおり、終日予定・繰り返し予定・例外日・非公開予定も、カレンダー側の
 * busy設定に従ってGoogleが返す内容をそのまま使う。free扱いの予定は返らない。
 * （＝終日予定を「予定あり」にしていないと塞がらない。運用手順で案内する）
 *
 * @param {number} timeMinMs
 * @param {number} timeMaxMs
 * @param {object} env process.env
 * @returns {Promise<Array<{start:number,end:number}>>}
 */
export async function fetchBusy(timeMinMs, timeMaxMs, env = process.env) {
  const ids = (env.GOOGLE_CALENDAR_IDS || 'primary')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const token = await getAccessToken(env);

  const res = await fetch(FREEBUSY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timeMin: new Date(timeMinMs).toISOString(),
      timeMax: new Date(timeMaxMs).toISOString(),
      timeZone: 'Asia/Tokyo',
      items: ids.map((id) => ({ id }))
    })
  });

  if (!res.ok) {
    throw new CalendarError(`カレンダーの空き状況を取得できませんでした (HTTP ${res.status})`);
  }

  const json = await res.json();
  const out = [];

  for (const id of ids) {
    const cal = json.calendars?.[id];
    if (!cal) {
      throw new CalendarError(`カレンダー「${id}」の応答がありません。共有設定をご確認ください。`);
    }
    if (cal.errors?.length) {
      // 共有が外れた・IDが違う等。空きとして扱わず必ず失敗させる。
      throw new CalendarError(`カレンダー「${id}」を読み取れません（${cal.errors[0].reason}）。`);
    }
    for (const b of cal.busy || []) {
      const start = Date.parse(b.start);
      const end = Date.parse(b.end);
      if (Number.isFinite(start) && Number.isFinite(end)) out.push({ start, end });
    }
  }

  return out;
}

/** テスト用にアクセストークンのキャッシュを空にする。 */
export function _resetAuthCache() {
  cachedToken = null;
}

/**
 * 管理者向けの「Googleカレンダーに追加」リンク（第7節）。
 * 予定作成テンプレートURLを組み立てるだけで、APIによる書き込みはしない。
 * 期間は往路出発D〜帰着Aとし、移動込みで枠を塞げるようにする。
 */
export function calendarTemplateUrl({ departMs, arriveBackMs, title, details, location }) {
  const fmt = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${fmt(departMs)}/${fmt(arriveBackMs)}`,
    details,
    ctz: 'Asia/Tokyo'
  });
  if (location) params.set('location', location);
  return `https://calendar.google.com/calendar/render?${params}`;
}
