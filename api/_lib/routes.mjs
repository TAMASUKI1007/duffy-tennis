/**
 * 経路照会（要件定義書 第5節）。
 *
 * NAVITIME route_transit を使う。仕様上の要点:
 *   - start / goal は「緯度,経度」で指定できる（＝コートの座標まで直接照会できる）
 *   - goal_time で到着時刻指定ができる → 往路「Sまでにコートに到着」に必須
 *   - start_time で出発時刻指定ができる → 復路「E以降に出発」
 *   - summary.move.time が総所要時間（分）
 *
 * 方針（第5-3節）:
 *   - 結果をキャッシュして同一条件の再照会を避ける
 *   - 1リクエストあたりの照会回数に上限を設ける
 *   - 取得できなければ null を返す。推測値で埋めない（第5節）
 *
 * 運賃（summary.move.fare）は取得できるが、お客さん向けには一切出さない（第6-2節）。
 */

/** 出発・帰着地点。第2節で東小金井駅に固定。 */
export const HOME_COORD = process.env.HOME_COORD || '35.701700,139.524400';
export const HOME_NAME = '東小金井駅';

/** 車・飛行機・フェリーは対象外（第2節：徒歩・自転車・電車・バスのみ）。 */
const UNUSE = 'domestic_flight.ferry';

/**
 * 同一コート・同一日・同一時刻の照会結果を一定時間だけ持つ（確認リスト#9で24時間）。
 * サーバーレスのインスタンス内メモリなので、インスタンスが入れ替われば消える。
 * 消えても正しさには影響せず、照会回数が増えるだけ。
 */
const CACHE_TTL_MS = 24 * 3600 * 1000;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value) {
  // 無制限に増やさない
  if (cache.size > 2000) cache.clear();
  cache.set(key, { at: Date.now(), value });
}

export class RouteError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'RouteError';
    this.cause = cause;
  }
}

/** NAVITIMEが要求する 'YYYY-MM-DDThh:mm:ss'（JSTの壁時計）。 */
function naviTime(ms) {
  const d = new Date(ms + 9 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`;
}

/**
 * 経路を1本照会する。
 * @returns {Promise<{minutes:number, modes:string[], fare:number|null}|null>} 取得できなければ null
 */
async function queryOnce({ start, goal, goalTimeMs, startTimeMs }, env) {
  const key = `${start}|${goal}|${goalTimeMs ?? ''}|${startTimeMs ?? ''}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const apiKey = env.RAPIDAPI_KEY;
  const host = env.RAPIDAPI_HOST || 'navitime-route-totalnavi.p.rapidapi.com';
  if (!apiKey) throw new RouteError('経路APIのキーが設定されていません。');

  const params = new URLSearchParams({ start, goal, datum: 'wgs84', term: '1440', limit: '3', unuse: UNUSE });
  if (goalTimeMs != null) params.set('goal_time', naviTime(goalTimeMs));
  else params.set('start_time', naviTime(startTimeMs));

  let res;
  try {
    res = await fetch(`https://${host}/route_transit?${params}`, {
      headers: { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': host }
    });
  } catch (e) {
    throw new RouteError('経路サービスに接続できませんでした。', e);
  }

  if (res.status === 429) throw new RouteError('経路サービスの利用上限に達しました。');
  if (!res.ok) throw new RouteError(`経路サービスがエラーを返しました (HTTP ${res.status})`);

  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new RouteError('経路サービスの応答を解釈できませんでした。', e);
  }

  const items = json.items || [];
  if (!items.length) {
    // その時刻に成立する公共交通経路が無い。障害ではないので null を返し、
    // 呼び出し側は「この枠は出せない」として扱う（受入条件「運行が成立しない経路は
    // 候補の根拠にしない」）。
    cacheSet(key, null);
    return null;
  }

  const best = items.reduce((a, b) =>
    (a?.summary?.move?.time ?? Infinity) <= (b?.summary?.move?.time ?? Infinity) ? a : b);

  const minutes = best?.summary?.move?.time;
  if (!Number.isFinite(minutes)) {
    cacheSet(key, null);
    return null;
  }

  const value = {
    minutes,
    modes: [...new Set((best.sections || []).filter((s) => s.type === 'move').map((s) => s.move))],
    fare: best?.summary?.move?.fare?.unit_0 ?? null // 内部保持のみ。顧客には返さない。
  };
  cacheSet(key, value);
  return value;
}

/**
 * 往復の所要時間を返す関数を作る。customerCourtSlots に渡して使う。
 *
 * 往路は「レッスン開始Sまでに到着」→ goal_time = S
 * 復路は「レッスン終了E以降に出発」→ start_time = E
 * 第4節「往復で同じ所要時間とは仮定しない」ため、必ず別々に照会する。
 *
 * @param {string} courtCoord '緯度,経度'
 * @param {{budget:{used:number,max:number}}} ctx 呼び出し回数の予算。共有オブジェクトを渡す。
 */
export function makeTravelLookup(courtCoord, ctx, env = process.env) {
  return async function lookupTravel(slot) {
    // 1枠につき往路・復路の2回を消費する
    if (ctx.budget.used + 2 > ctx.budget.max) {
      ctx.budget.exhausted = true;
      return null;
    }
    ctx.budget.used += 2;

    const [outbound, inbound] = await Promise.all([
      queryOnce({ start: HOME_COORD, goal: courtCoord, goalTimeMs: slot.start }, env),
      queryOnce({ start: courtCoord, goal: HOME_COORD, startTimeMs: slot.end }, env)
    ]);

    if (!outbound || !inbound) return null;

    return {
      outboundMin: outbound.minutes,
      inboundMin: inbound.minutes,
      outboundModes: outbound.modes,
      inboundModes: inbound.modes
    };
  };
}

/** テスト用にキャッシュを空にする。 */
export function _clearCache() {
  cache.clear();
}
