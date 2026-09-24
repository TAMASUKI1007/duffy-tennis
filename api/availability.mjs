/**
 * POST /api/availability
 *
 * 指定日の候補レッスン開始時刻を返す（要件定義書 第3節・第4節）。
 *
 * 入力: { mode: 'operator'|'customer', date: 'YYYY-MM-DD', courtCoord?: '緯度,経度' }
 * 出力: { ok:true, slots:[{startIso,endIso,label,...}], notice? }
 *
 * 顧客へ返すのは候補日時と移動の所要時間だけ。予定の件名・参加者・運賃は返さない
 * （第8節・第6-2節・受入条件「個人の予定の詳細を顧客画面や公開APIレスポンスに露出しない」）。
 */

import { handler, readJson, sendJson, throttle, PublicError } from './_lib/http.mjs';
import {
  operatorArrangedSlots, customerCourtSlots, normalizeBusy,
  pendingReservationsAsBusy, isBookableDate, jstToEpoch, toJstIso, epochToJst
} from './_lib/slots.mjs';
import { fetchBusy } from './_lib/google-calendar.mjs';
import { makeTravelLookup } from './_lib/routes.mjs';
import { fetchPendingIntervals } from './_lib/supabase.mjs';
import { parseCoord } from './_lib/geocode.mjs';

/** 1回の表示あたりの経路照会上限（確認リスト#8）。往復で2消費するので20=10枠ぶん。 */
const MAX_ROUTE_LOOKUPS = 20;

const WD = '日月火水木金土';

export default handler(async (req, res) => {
  throttle(req, { limit: 40, windowMs: 60000, key: 'availability' });

  const body = await readJson(req);
  const mode = body.mode === 'customer' ? 'customer' : body.mode === 'operator' ? 'operator' : null;
  const date = typeof body.date === 'string' ? body.date.trim() : '';

  if (!mode) throw new PublicError('コート手配の方法が指定されていません。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PublicError('日付の形式が正しくありません。');
  if (!isBookableDate(date)) {
    throw new PublicError('この日付は受付対象外です（2日後〜30日先からお選びください）。');
  }

  // 移動が8:00前・20:00後にはみ出すので、前後に余裕を持たせて取得する
  const windowFrom = jstToEpoch(date, -6 * 60);
  const windowTo = jstToEpoch(date, 30 * 60);

  // --- カレンダーのbusy（失敗したら例外。空きとして扱わない） ---
  const calendarBusy = await fetchBusy(windowFrom, windowTo);

  // --- 相談待ちの仮予約も塞ぐ（確認リスト#4） ---
  // ここが取れなくても候補表示は続行できるが、二重相談が起きうるので警告を返す。
  let pendingBusy = [];
  let pendingWarning = null;
  try {
    const rows = await fetchPendingIntervals(windowFrom, windowTo);
    pendingBusy = pendingReservationsAsBusy(rows);
  } catch (e) {
    pendingWarning = '同時申込の確認ができませんでした。日時が重なる場合はLINEで調整させていただきます。';
  }

  const busy = normalizeBusy([...calendarBusy, ...pendingBusy]);

  // --- 候補算出 ---
  let result;
  let travelNote;

  if (mode === 'operator') {
    // 三鷹周辺・片道1時間の固定。経路APIは呼ばない＝照会0件。
    result = operatorArrangedSlots(date, busy);
    travelNote = '往復の移動（片道1時間）を含めて空き時間を確認しています。';
  } else {
    const courtCoord = parseCoord(body.courtCoord);
    if (!courtCoord) {
      throw new PublicError('コートの場所が特定できていません。コート名を検索して候補からお選びください。');
    }
    const ctx = { budget: { used: 0, max: MAX_ROUTE_LOOKUPS, exhausted: false } };
    result = await customerCourtSlots(date, busy, makeTravelLookup(courtCoord, ctx), {
      maxLookups: Math.floor(MAX_ROUTE_LOOKUPS / 2)
    });
    travelNote = '東小金井駅からの往復の実際の経路をもとに空き時間を確認しています。';
  }

  // --- 応答の組み立て（内部情報を出さない） ---
  const slots = result.slots.map((s) => {
    const st = epochToJst(s.start);
    const en = epochToJst(s.end);
    return {
      startIso: toJstIso(s.start),
      endIso: toJstIso(s.end),
      label: `${st.hhmm}〜${en.hhmm}`,
      departLabel: epochToJst(s.depart).hhmm,
      arriveBackLabel: epochToJst(s.arriveBack).hhmm,
      outboundMin: s.outboundMin,
      inboundMin: s.inboundMin
    };
  });

  const notices = [];
  if (pendingWarning) notices.push(pendingWarning);

  if (mode === 'customer') {
    if (result.truncated) {
      notices.push('この日の確認は上限まで行いました。ご希望の時間帯が見つからない場合はLINEでご相談ください。');
    }
    if (result.unresolved > 0 && slots.length === 0) {
      notices.push('この日は公共交通での往復経路が見つかりませんでした。別の日をお試しいただくか、LINEでご相談ください。');
    }
  }

  // サーバー（Vercel）はUTCで動くので、Dateのローカル系メソッドは使わない。
  // 必ずJSTに直してから月日・曜日を組み立てる。
  const noon = epochToJst(jstToEpoch(date, 12 * 60));
  const [, mm, dd] = noon.date.split('-').map(Number);

  return sendJson(res, 200, {
    ok: true,
    date,
    dateLabel: `${mm}/${dd}(${WD[noon.dow]})`,
    mode,
    slots,
    travelNote,
    notices,
    // 運用の可視化用。個人情報ではない。
    diagnostics: { checked: result.checked, lookups: result.lookups ?? 0, unresolved: result.unresolved ?? 0 }
  });
});
