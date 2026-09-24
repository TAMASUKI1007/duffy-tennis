/**
 * Supabaseへのアクセス（要件定義書 第7節・第8節）。
 *
 * ここはサーバー側専用。service_role キーを使うため、絶対にブラウザへ渡さない。
 * ブラウザからの直接POSTは廃止し、/api/reserve 経由に一本化する。
 * （匿名キーでの直接書き込みはサーバー側検証を迂回できるため）
 */

export class StorageError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StorageError';
    this.cause = cause;
  }
}

function config(env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new StorageError('申込の保存先が設定されていません。');
  return { url: url.replace(/\/$/, ''), key };
}

function headers(key, extra = {}) {
  return {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...extra
  };
}

/**
 * 仮予約を1件保存する。
 * 保存に失敗したら必ず例外を投げる。呼び出し側は完了画面を出してはならない（第8節）。
 */
export async function insertReservation(row, env = process.env) {
  const { url, key } = config(env);

  const res = await fetch(`${url}/rest/v1/applications`, {
    method: 'POST',
    headers: headers(key, { Prefer: 'return=representation' }),
    body: JSON.stringify(row)
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new StorageError(`申込を保存できませんでした (HTTP ${res.status})`, detail.slice(0, 200));
  }

  const rows = await res.json().catch(() => []);
  return rows[0] || null;
}

/**
 * 空き判定に使うため、相談待ちの仮予約の移動込み区間を取得する（第4節）。
 * 個人情報は取得しない。必要なのは時刻とステータスだけ。
 */
export async function fetchPendingIntervals(fromMs, toMs, env = process.env) {
  const { url, key } = config(env);

  const params = new URLSearchParams({
    select: 'status,created_at,depart_at,arrive_back_at',
    status: 'eq.pending',
    arrive_back_at: `gte.${new Date(fromMs).toISOString()}`,
    depart_at: `lte.${new Date(toMs).toISOString()}`
  });

  const res = await fetch(`${url}/rest/v1/applications?${params}`, { headers: headers(key) });

  if (!res.ok) {
    throw new StorageError(`仮予約の状況を取得できませんでした (HTTP ${res.status})`);
  }
  return res.json();
}

/**
 * 同一内容の連続送信を弾く（第8節「再送による同一申込の重複防止」）。
 * 直近の同一メールアドレス・同一開始時刻の申込があれば、その受付番号を返す。
 */
export async function findDuplicate(email, startIso, env = process.env) {
  const { url, key } = config(env);
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const params = new URLSearchParams({
    select: 'reference_code,created_at',
    email: `eq.${email}`,
    lesson_start_at: `eq.${startIso}`,
    created_at: `gte.${since}`,
    limit: '1'
  });

  const res = await fetch(`${url}/rest/v1/applications?${params}`, { headers: headers(key) });
  if (!res.ok) return null; // 重複チェックの失敗で申込全体を止めない
  const rows = await res.json().catch(() => []);
  return rows[0] || null;
}

/**
 * メール送信に失敗したことを記録する（確認リスト#13改）。
 * 保存済みなら完了扱いでよいが、管理者が後から気づけるようにする。
 */
export async function markNotifyFailed(referenceCode, reason, env = process.env) {
  try {
    const { url, key } = config(env);
    await fetch(`${url}/rest/v1/applications?reference_code=eq.${encodeURIComponent(referenceCode)}`, {
      method: 'PATCH',
      headers: headers(key, { Prefer: 'return=minimal' }),
      body: JSON.stringify({ notify_status: 'failed', notify_error: String(reason).slice(0, 300) })
    });
  } catch {
    // ここでの失敗は申込の成否に影響させない
  }
}
