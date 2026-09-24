/**
 * POST /api/reserve
 *
 * 仮予約を受け付けて保存する（要件定義書 第3節A-6/B-5・第7節・第8節）。
 *
 * 重要な性質:
 *   - 保存に成功したときだけ ok:true を返す。失敗時に受付完了としない（第8節）。
 *   - 送信直前にカレンダーを再確認する。埋まっていたら再選択を案内する（受入条件）。
 *   - ブラウザから来た日時をそのまま信用せず、サーバー側で全部検証し直す。
 *   - 返すのは受付番号・LINE本文・メール用の文面だけ。予定の詳細や運賃は返さない。
 */

import { handler, readJson, sendJson, throttle, PublicError, makeReferenceCode } from './_lib/http.mjs';
import {
  operatorArrangedSlots, customerCourtSlots, normalizeBusy, pendingReservationsAsBusy,
  isBookableDate, validateSlotShape, jstToEpoch, toJstIso, epochToJst, LESSON_MINUTES
} from './_lib/slots.mjs';
import { fetchBusy, calendarTemplateUrl } from './_lib/google-calendar.mjs';
import { makeTravelLookup, HOME_NAME } from './_lib/routes.mjs';
import { insertReservation, fetchPendingIntervals, findDuplicate } from './_lib/supabase.mjs';
import { parseCoord } from './_lib/geocode.mjs';

const LESSON_FEE = 16500;
const RENTAL_FEE = 1200;
const WD = '日月火水木金土';

function str(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function fmtSlot(startMs) {
  const s = epochToJst(startMs);
  const e = epochToJst(startMs + LESSON_MINUTES * 60000);
  const [y, m, d] = s.date.split('-').map(Number);
  const dow = WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d}(${dow}) ${s.hhmm}〜${e.hhmm}`;
}

/**
 * 1つの希望日時が、いま実際に予約可能かを確認する。
 * @returns {{start:number,end:number,depart:number,arriveBack:number}}
 */
async function verifyChoice(choice, mode, courtCoord, label) {
  const start = Date.parse(choice);
  if (!Number.isFinite(start)) throw new PublicError(`${label}の日時が不正です。`);
  const end = start + LESSON_MINUTES * 60000;

  // 形（2時間・8:00〜20:00）の検証
  const shapeErrors = validateSlotShape(start, end);
  if (shapeErrors.length) throw new PublicError(`${label}: ${shapeErrors.join(' ')}`);

  const date = epochToJst(start).date;
  if (!isBookableDate(date)) {
    throw new PublicError(`${label}は受付対象外の日付です（2日後〜30日先）。`);
  }

  const windowFrom = jstToEpoch(date, -6 * 60);
  const windowTo = jstToEpoch(date, 30 * 60);

  const calendarBusy = await fetchBusy(windowFrom, windowTo);
  let pendingBusy = [];
  try {
    pendingBusy = pendingReservationsAsBusy(await fetchPendingIntervals(windowFrom, windowTo));
  } catch {
    // 取得できなくても保存は続行する（重なりはLINEで調整する運用）
  }
  const busy = normalizeBusy([...calendarBusy, ...pendingBusy]);

  // 同じ計算器を通して、その開始時刻が候補に含まれるかを確かめる
  let slots;
  if (mode === 'operator') {
    slots = operatorArrangedSlots(date, busy).slots;
  } else {
    const ctx = { budget: { used: 0, max: 4, exhausted: false } };
    // この1枠だけを照会するため、対象の開始時刻に限定した lookup を作る
    const lookup = makeTravelLookup(courtCoord, ctx);
    const r = await customerCourtSlots(date, busy, async (slot) => (
      slot.start === start ? lookup(slot) : null
    ), { maxLookups: 21 });
    slots = r.slots;
  }

  const found = slots.find((s) => s.start === start);
  if (!found) {
    throw new PublicError(
      `${label}（${fmtSlot(start)}）は、ただいま予定が入っているためお受けできません。恐れ入りますが日時を選び直してください。`,
      409, 'slot_taken'
    );
  }
  return found;
}

export default handler(async (req, res) => {
  throttle(req, { limit: 6, windowMs: 60000, key: 'reserve' });

  const body = await readJson(req);

  // --- 入力の検証（第8節：サーバー側検証） ---
  const menu = body.menu === 'online' ? 'online' : 'offline';
  const mode = body.mode === 'customer' ? 'customer' : body.mode === 'operator' ? 'operator' : null;
  // 対面レッスンのときだけコート手配の指定が要る。オンライン動画添削には日程も移動もない。
  if (menu === 'offline' && !mode) throw new PublicError('コート手配の方法が指定されていません。');

  const name = str(body.name, 100);
  const email = str(body.email, 200);
  const phone = str(body.phone, 40);
  const sns = str(body.sns, 100);
  const category = str(body.category, 40);
  const people = Math.min(Math.max(parseInt(body.people, 10) || 1, 1), 10);
  const rental = body.rental === 'あり' ? 'あり' : 'なし';
  const payment = str(body.payment, 40);
  const question = str(body.question, 1000);
  const guardianConsent = !!body.guardianConsent;
  const courtReserve = !!body.courtReserve;

  if (!name) throw new PublicError('お名前を入力してください。');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new PublicError('メールアドレスの形式をご確認ください。');
  if (!phone) throw new PublicError('電話番号を入力してください。');
  if (!body.agree) throw new PublicError('利用規約への同意が必要です。');

  // ===== オンライン動画添削（日程・コート・移動なし。既存の挙動を維持する） =====
  if (menu === 'online') {
    const plan = str(body.plan, 10);
    const PLAN_PRICES = { '3': 2400, '5': 3750, '10': 6500 };
    if (!PLAN_PRICES[plan]) throw new PublicError('チケットプランを選択してください。');

    const referenceCode = makeReferenceCode();
    await insertReservation({
      reference_code: referenceCode,
      status: 'pending',
      name, sns, email, phone, category,
      guardian_consent: guardianConsent,
      menu: 'オンライン動画添削',
      plan,
      payment, question,
      estimate: PLAN_PRICES[plan],
      notify_status: 'pending'
    });

    const oaIdOnline = process.env.LINE_OA_ID || '';
    const lineBodyOnline = [
      `お申込みの受付番号：${referenceCode}`,
      `お名前：${name}`,
      `メニュー：オンライン動画添削（${plan}回チケット）`,
      'よろしくお願いします。'
    ].join('\n');

    const summaryOnline = [
      `受付番号：${referenceCode}`,
      `メニュー：オンライン動画添削`,
      `チケット：${plan}回 ¥${PLAN_PRICES[plan].toLocaleString('ja-JP')}`
    ];

    return sendJson(res, 200, {
      ok: true,
      referenceCode,
      lineUrl: oaIdOnline
        ? `https://line.me/R/oaMessage/${encodeURIComponent(oaIdOnline)}/?${encodeURIComponent(lineBodyOnline)}`
        : null,
      lineMessage: lineBodyOnline,
      summary: summaryOnline,
      emailParams: {
        name, customer_email: email, email, phone,
        sns: sns || '(未記入)', category,
        menu: 'オンライン動画添削',
        reference_code: referenceCode,
        message: [
          '■お申込みを受け付けました',
          ...summaryOnline,
          `お支払い方法：${payment}`,
          `ご質問・ご要望：${question || '(なし)'}`,
          '',
          'LINE公式で受付番号をお送りください。お支払い方法をご案内します。'
        ].join('\n')
      }
    });
  }

  // ===== 対面レッスン =====
  let courtCoord = null;
  let courtName = '';
  let courtAddress = '';

  if (mode === 'customer') {
    courtCoord = parseCoord(body.courtCoord);
    courtName = str(body.courtName, 200);
    courtAddress = str(body.courtAddress, 300);
    if (!courtCoord || !courtName) {
      throw new PublicError('コートを検索して候補からお選びください。');
    }
  }

  // --- 希望日時の検証（第1希望は必須、第2希望は任意。両方とも同じルールで検証する） ---
  const choice1 = await verifyChoice(body.choice1, mode, courtCoord, '第1希望');
  let choice2 = null;
  if (body.choice2) {
    if (Date.parse(body.choice2) === choice1.start) {
      throw new PublicError('第1希望と第2希望が同じ日時です。');
    }
    choice2 = await verifyChoice(body.choice2, mode, courtCoord, '第2希望');
  }

  // --- 二重送信の防止（第8節） ---
  const startIso = toJstIso(choice1.start);
  const dup = await findDuplicate(email, startIso);
  if (dup?.reference_code) {
    return sendJson(res, 200, {
      ok: true,
      duplicate: true,
      referenceCode: dup.reference_code,
      message: 'すでに同じ内容で仮予約を受け付けております。'
    });
  }

  // --- 保存 ---
  const referenceCode = makeReferenceCode();
  const estimate = LESSON_FEE + (rental === 'あり' ? RENTAL_FEE : 0);

  const row = {
    reference_code: referenceCode,
    status: 'pending',
    name, sns, email, phone, category,
    guardian_consent: guardianConsent,
    menu: '対面レッスン',
    people,
    court_arranger: mode,                     // 'operator' | 'customer'
    court: mode === 'customer' ? courtName : '（運営者手配・三鷹周辺）',
    court_address: courtAddress || null,
    court_coord: courtCoord,
    court_reserve: mode === 'operator' ? true : courtReserve,
    rental,
    lesson_start_at: startIso,
    lesson_end_at: toJstIso(choice1.end),
    depart_at: toJstIso(choice1.depart),
    arrive_back_at: toJstIso(choice1.arriveBack),
    outbound_minutes: choice1.outboundMin,
    inbound_minutes: choice1.inboundMin,
    alt_lesson_start_at: choice2 ? toJstIso(choice2.start) : null,
    alt_lesson_end_at: choice2 ? toJstIso(choice2.end) : null,
    alt_depart_at: choice2 ? toJstIso(choice2.depart) : null,
    alt_arrive_back_at: choice2 ? toJstIso(choice2.arriveBack) : null,
    date1: fmtSlot(choice1.start),            // 既存カラムとの互換（表示用文字列）
    date2: choice2 ? fmtSlot(choice2.start) : null,
    payment, question, estimate,
    notify_status: 'pending'
  };

  // 失敗したら例外。ここで止まれば完了画面は出ない（第8節）。
  await insertReservation(row);

  // --- LINE引き継ぎ（第6節） ---
  const lineBody = [
    `仮予約の受付番号：${referenceCode}`,
    `お名前：${name}`,
    `第1希望：${fmtSlot(choice1.start)}`,
    choice2 ? `第2希望：${fmtSlot(choice2.start)}` : null,
    `コート：${mode === 'customer' ? courtName : '運営者手配（三鷹周辺）'}`,
    'よろしくお願いします。'
  ].filter(Boolean).join('\n');

  const oaId = process.env.LINE_OA_ID || '';
  const lineUrl = oaId
    ? `https://line.me/R/oaMessage/${encodeURIComponent(oaId)}/?${encodeURIComponent(lineBody)}`
    : null;

  // --- 管理者向け「Googleカレンダーに追加」リンク（第7節） ---
  // 期間は往路出発D〜帰着A。移動込みで塞げるようにする。APIでの書き込みはしない。
  const adminCalendarUrl = calendarTemplateUrl({
    departMs: choice1.depart,
    arriveBackMs: choice1.arriveBack,
    title: `テニスレッスン（移動含む）${name}様 ${referenceCode}`,
    location: mode === 'customer' ? (courtAddress || courtName) : '三鷹周辺（調整中）',
    details: [
      `受付番号：${referenceCode}`,
      `※この予定は往路出発〜帰着までを含みます（レッスンは ${fmtSlot(choice1.start)}）`,
      `出発：${HOME_NAME} ${epochToJst(choice1.depart).hhmm} / 帰着 ${epochToJst(choice1.arriveBack).hhmm}`,
      `コート：${mode === 'customer' ? courtName : '運営者手配（三鷹周辺）'}`,
      `人数：${people}人 / ボールレンタル：${rental}`,
      '',
      '※LINEで最終確定してから保存してください。'
    ].join('\n')
  });

  const summaryLines = [
    `受付番号：${referenceCode}`,
    `第1希望：${fmtSlot(choice1.start)}`,
    choice2 ? `第2希望：${fmtSlot(choice2.start)}` : null,
    `コート：${mode === 'customer' ? courtName : '運営者手配（三鷹周辺）'}`,
    `人数：${people}人`,
    `ボールレンタル：${rental}`
  ].filter(Boolean);

  return sendJson(res, 200, {
    ok: true,
    referenceCode,
    lineUrl,
    lineMessage: lineBody,
    summary: summaryLines,
    // EmailJS はブラウザ側で送る。文面はサーバーで組み立てて渡す。
    emailParams: {
      name,
      customer_email: email,
      email,
      phone,
      sns: sns || '(未記入)',
      category,
      menu: '対面レッスン',
      reference_code: referenceCode,
      message: [
        '■仮予約を受け付けました（予約はまだ確定していません）',
        ...summaryLines,
        `お支払い方法：${payment}`,
        `概算金額：¥${estimate.toLocaleString('ja-JP')}（移動費別）`,
        `ご質問・ご要望：${question || '(なし)'}`,
        '',
        'LINE公式で受付番号をお送りください。コートと日時を確認して予約を確定します。'
      ].join('\n'),
      // 管理者用テンプレートでのみ使う
      admin_calendar_url: adminCalendarUrl,
      admin_travel: `往路出発 ${epochToJst(choice1.depart).hhmm} 〜 帰着 ${epochToJst(choice1.arriveBack).hhmm}（移動込み）`
    }
  });
});
