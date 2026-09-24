/**
 * 空き枠計算（要件定義書 第4節）。
 *
 * このファイルは純粋関数だけで構成する。外部APIもI/Oも持たない。
 * 空き枠の判定を決定的なコードで行う（第5節「日時の比較・重複判定は決定的なコードで行う」）
 * という要件のため、ここにテストを集中させる。
 *
 * 時刻の扱い:
 *   日本は夏時間を採用していないため、JST = UTC+9 の固定オフセットで厳密に計算できる。
 *   サーバ（Vercel）のローカルタイムゾーンに依存しないよう、内部は常に epoch ミリ秒で扱い、
 *   壁時計との変換はこのファイルの関数だけを通す。
 */

/** JSTのUTCからのオフセット（分）。日本にDSTは無いので固定値で正しい。 */
export const JST_OFFSET_MIN = 9 * 60;

/** レッスンの長さ（分）。第2節より1回2時間。 */
export const LESSON_MINUTES = 120;

/** 1日のレッスン可能帯（JSTの深夜0時からの分）。08:00〜20:00。 */
export const DAY_START_MIN = 8 * 60;
export const DAY_END_MIN = 20 * 60;

/** 運営者手配のときの固定片道移動時間（分）。第2節より片道1時間。 */
export const FIXED_TRAVEL_MIN = 60;

/** 候補開始時刻の刻み（分）。確認リスト#2で30分に確定。 */
export const DEFAULT_STEP_MIN = 30;

/**
 * 'YYYY-MM-DD' とその日のJST深夜0時からの経過分から epoch ミリ秒を得る。
 * minutesFromMidnight は負値や1440超も許す（前日夜・翌日未明の移動を表せる）。
 */
export function jstToEpoch(dateStr, minutesFromMidnight) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const midnightUtc = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  return midnightUtc - JST_OFFSET_MIN * 60000 + minutesFromMidnight * 60000;
}

/** epoch ミリ秒を JST の壁時計表現に戻す。 */
export function epochToJst(ms) {
  const d = new Date(ms + JST_OFFSET_MIN * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    hhmm: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
    dow: d.getUTCDay()
  };
}

/** ISO 8601（+09:00付き）。Googleカレンダーの予定作成URLやDB保存に使う。 */
export function toJstIso(ms) {
  const t = epochToJst(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.date}T${p(t.hours)}:${p(t.minutes)}:00+09:00`;
}

/**
 * 半開区間 [aStart, aEnd) と [bStart, bEnd) が重なるか。
 *
 * 第4節「別予定がDに終了、またはAに開始する場合は重複なし」。
 * つまり端点の接触は重複としない。追加の安全余白は足さない（ユーザー指定）。
 */
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * 区間 [start, end) が busy 配列のどれとも重ならないか。
 * busy は [{ start, end }]（epoch ミリ秒）。
 */
export function isFree(start, end, busy) {
  for (const b of busy) {
    if (overlaps(start, end, b.start, b.end)) return false;
  }
  return true;
}

/**
 * busy区間を正規化する（ソートして、重なり・隣接をマージする）。
 * Googleカレンダーの複数カレンダーぶんを合成するときに使う。
 */
export function normalizeBusy(busy) {
  const sorted = busy
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    // 端点が接するだけ（last.end === b.start）なら別区間のままで構わないが、
    // マージしても半開区間の判定結果は変わらないのでまとめて扱いを軽くする。
    if (last && b.start <= last.end) {
      last.end = Math.max(last.end, b.end);
    } else {
      out.push({ start: b.start, end: b.end });
    }
  }
  return out;
}

/**
 * その日の候補となるレッスン開始時刻を列挙する。
 *
 * 第2節: S >= 08:00、E = S + 120分 <= 20:00 → S は 08:00〜18:00。
 * 生成のみを担当し、空き判定はしない。
 */
export function candidateStarts(dateStr, stepMin = DEFAULT_STEP_MIN) {
  const out = [];
  const lastStart = DAY_END_MIN - LESSON_MINUTES; // 18:00
  for (let m = DAY_START_MIN; m <= lastStart; m += stepMin) {
    out.push({ startMin: m, start: jstToEpoch(dateStr, m), end: jstToEpoch(dateStr, m + LESSON_MINUTES) });
  }
  return out;
}

/**
 * 運営者がコートを手配する場合の空き枠（第3節B / 第4節）。
 *
 * D = S - 60分、A = E + 60分。合計4時間の連続した空きが必要。
 * 経路APIは一切呼ばない（＝照会費用ゼロ）。
 *
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {Array<{start:number,end:number}>} busy 正規化済みbusy区間
 * @param {{stepMin?:number, now?:number, minLeadMs?:number}} opts
 * @returns {{slots:Array, checked:number}}
 */
export function operatorArrangedSlots(dateStr, busy, opts = {}) {
  const stepMin = opts.stepMin ?? DEFAULT_STEP_MIN;
  const slots = [];
  const cands = candidateStarts(dateStr, stepMin);

  for (const c of cands) {
    const depart = c.start - FIXED_TRAVEL_MIN * 60000;
    const arriveBack = c.end + FIXED_TRAVEL_MIN * 60000;

    // 受入条件「固定移動方式では必ず合計4時間を検査する」
    // [D,A) は 60 + 120 + 60 = 240分であることを不変条件として持つ。
    if (arriveBack - depart !== (FIXED_TRAVEL_MIN * 2 + LESSON_MINUTES) * 60000) {
      throw new Error('内部エラー: 固定移動方式の占有区間が4時間になっていません');
    }

    if (!isFree(depart, arriveBack, busy)) continue;

    slots.push({
      start: c.start,
      end: c.end,
      depart,
      arriveBack,
      outboundMin: FIXED_TRAVEL_MIN,
      inboundMin: FIXED_TRAVEL_MIN,
      basis: 'fixed'
    });
  }
  return { slots, checked: cands.length };
}

/**
 * お客さんがコートを指定する場合の空き枠（第3節A / 第4節 / 第5-3節）。
 *
 * 経路照会は有料かつ時間がかかるので、次の順で絞る:
 *   1. レッスン本体 [S,E) がbusyと重なる候補を先に捨てる（必要条件。APIを呼ばずに判定できる）
 *   2. 残った候補についてのみ経路を照会する。照会上限に達したらそこで打ち切る
 *   3. 往復移動を含む [D,A) を再判定する
 *
 * 経路が取得できなかった候補は「空き」にしない。unresolved として返し、
 * 呼び出し側が「候補なし」と「障害」を区別できるようにする（第8節）。
 *
 * @param {string} dateStr
 * @param {Array<{start:number,end:number}>} busy
 * @param {(slot:{start:number,end:number,startMin:number}) => Promise<{outboundMin:number,inboundMin:number}|null>} lookupTravel
 *        経路照会。取得できなければ null を返すこと。例外は呼び出し元に伝播する。
 * @param {{stepMin?:number, maxLookups?:number}} opts
 */
export async function customerCourtSlots(dateStr, busy, lookupTravel, opts = {}) {
  const stepMin = opts.stepMin ?? DEFAULT_STEP_MIN;
  const maxLookups = opts.maxLookups ?? 20;

  const cands = candidateStarts(dateStr, stepMin);

  // 手順1: レッスン本体が空いている候補だけを残す（APIを呼ばない事前絞り込み）
  const lessonFree = cands.filter((c) => isFree(c.start, c.end, busy));

  const slots = [];
  let lookups = 0;
  let unresolved = 0;
  let truncated = false;

  // 手順2-3: 残った候補だけ経路を照会する
  for (const c of lessonFree) {
    if (lookups >= maxLookups) {
      truncated = true;
      break;
    }
    lookups++;

    const travel = await lookupTravel(c);
    if (!travel || !Number.isFinite(travel.outboundMin) || !Number.isFinite(travel.inboundMin)) {
      // 経路不明を「空いている」と解釈しない（第4節）
      unresolved++;
      continue;
    }

    const depart = c.start - travel.outboundMin * 60000;
    const arriveBack = c.end + travel.inboundMin * 60000;

    if (!isFree(depart, arriveBack, busy)) continue;

    slots.push({
      start: c.start,
      end: c.end,
      depart,
      arriveBack,
      outboundMin: travel.outboundMin,
      inboundMin: travel.inboundMin,
      basis: 'route'
    });
  }

  return {
    slots,
    checked: cands.length,
    lessonFree: lessonFree.length,
    lookups,
    unresolved,
    truncated
  };
}

/**
 * 仮予約（相談待ち）をbusyとして扱うための変換（第4節 / 確認リスト#4）。
 * 移動込みの区間 [D,A) を塞ぐ。カレンダーへの書き込みは行わない。
 *
 * @param {Array<{depart_at:string, arrive_back_at:string, status:string, created_at:string}>} rows
 * @param {{expiryHours?:number, now?:number}} opts 相談待ちのまま放置された仮予約の失効（確認リスト#5で72時間）
 */
export function pendingReservationsAsBusy(rows, opts = {}) {
  const expiryHours = opts.expiryHours ?? 72;
  const now = opts.now ?? Date.now();
  const out = [];

  for (const r of rows) {
    if (r.status !== 'pending') continue;
    if (!r.depart_at || !r.arrive_back_at) continue;

    // 期限切れの仮予約は枠を塞がない
    const created = Date.parse(r.created_at);
    if (Number.isFinite(created) && now - created > expiryHours * 3600000) continue;

    const start = Date.parse(r.depart_at);
    const end = Date.parse(r.arrive_back_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    out.push({ start, end });
  }
  return out;
}

/**
 * 表示対象期間（確認リスト#1: 2日後〜30日先）。
 * 返すのは 'YYYY-MM-DD' の配列。
 */
export function bookableDates(now = Date.now(), fromDays = 2, toDays = 30) {
  const out = [];
  const today = epochToJst(now).date;
  for (let n = fromDays; n <= toDays; n++) {
    out.push(epochToJst(jstToEpoch(today, 0) + n * 86400000).date);
  }
  return out;
}

/** 日付が予約可能期間内か（サーバ側検証用。第8節）。 */
export function isBookableDate(dateStr, now = Date.now(), fromDays = 2, toDays = 30) {
  return bookableDates(now, fromDays, toDays).includes(dateStr);
}

/**
 * 申込として受理してよい枠かをサーバ側で最終検証する（第8節・受入条件）。
 * ブラウザから送られてきた開始時刻をそのまま信用しない。
 */
export function validateSlotShape(startMs, endMs) {
  const errors = [];
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    errors.push('開始・終了日時が不正です。');
    return errors;
  }
  if (endMs - startMs !== LESSON_MINUTES * 60000) {
    errors.push('レッスンは2時間である必要があります。');
  }
  const s = epochToJst(startMs);
  const e = epochToJst(endMs);
  const sMin = s.hours * 60 + s.minutes;
  const eMin = e.hours * 60 + e.minutes;

  if (sMin < DAY_START_MIN) errors.push('開始は8:00以降である必要があります。');
  // 20:00ちょうどの終了は可。20:00を超えるものだけ弾く。
  if (e.date !== s.date || eMin > DAY_END_MIN) {
    errors.push('終了は20:00以前である必要があります。');
  }
  return errors;
}
