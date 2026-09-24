/**
 * 空き枠計算の自動テスト（要件定義書 第9節「受入条件」に対応）。
 *
 * 実行: node --test tests/
 * 依存パッケージなし（node:test / node:assert を使用）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  jstToEpoch,
  epochToJst,
  toJstIso,
  overlaps,
  isFree,
  normalizeBusy,
  candidateStarts,
  operatorArrangedSlots,
  customerCourtSlots,
  pendingReservationsAsBusy,
  isBookableDate,
  validateSlotShape,
  LESSON_MINUTES,
  FIXED_TRAVEL_MIN
} from '../api/_lib/slots.mjs';

const DAY = '2026-10-15'; // 木曜

/** テスト内で読みやすく busy 区間を作る。 */
const busyAt = (from, to) => ({ start: jstToEpoch(DAY, hm(from)), end: jstToEpoch(DAY, hm(to)) });
function hm(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
const at = (s) => jstToEpoch(DAY, hm(s));
const hhmm = (ms) => epochToJst(ms).hhmm;

// ---------------------------------------------------------------------------
// 時刻の基礎（サーバのタイムゾーンに依存しないこと）
// ---------------------------------------------------------------------------

test('JST変換はサーバのタイムゾーンに依存しない', () => {
  // 2026-10-15 09:00 JST === 2026-10-15 00:00 UTC
  assert.equal(at('09:00'), Date.UTC(2026, 9, 15, 0, 0, 0));
  assert.equal(hhmm(at('09:00')), '09:00');
  assert.equal(toJstIso(at('18:30')), '2026-10-15T18:30:00+09:00');
});

test('日をまたぐ移動時刻も表現できる', () => {
  // 08:00開始で片道90分なら往路出発は06:30（同日）
  assert.equal(hhmm(at('08:00') - 90 * 60000), '06:30');
  // 20:00終了で復路120分なら帰着は22:00
  assert.equal(hhmm(at('20:00') + 120 * 60000), '22:00');
  // 深夜をまたぐケース
  const past = at('20:00') + 300 * 60000; // 翌01:00
  assert.equal(epochToJst(past).date, '2026-10-16');
  assert.equal(epochToJst(past).hhmm, '01:00');
});

// ---------------------------------------------------------------------------
// 半開区間 [D,A) — 第4節「Dに終了、またはAに開始する場合は重複なし」
// ---------------------------------------------------------------------------

test('端点が接触するだけの予定は重複としない（追加余白なし）', () => {
  const D = at('09:00');
  const A = at('13:00');

  // 予定がちょうどDに終了する
  assert.equal(overlaps(D, A, at('08:00'), at('09:00')), false);
  // 予定がちょうどAに開始する
  assert.equal(overlaps(D, A, at('13:00'), at('14:00')), false);
  // 1分でも食い込めば重複
  assert.equal(overlaps(D, A, at('08:00'), at('09:01')), true);
  assert.equal(overlaps(D, A, at('12:59'), at('14:00')), true);
});

test('normalizeBusy は重なりと隣接をまとめる', () => {
  const merged = normalizeBusy([
    busyAt('13:00', '14:00'),
    busyAt('09:00', '10:00'),
    busyAt('09:30', '11:00'),
    busyAt('14:00', '15:00')
  ]);
  assert.equal(merged.length, 2);
  assert.equal(hhmm(merged[0].start), '09:00');
  assert.equal(hhmm(merged[0].end), '11:00');
  assert.equal(hhmm(merged[1].start), '13:00');
  assert.equal(hhmm(merged[1].end), '15:00');
});

// ---------------------------------------------------------------------------
// 候補開始時刻の境界 — 受入条件「08:00より前の開始、20:00を超える終了を受付しない」
// ---------------------------------------------------------------------------

test('候補開始は08:00〜18:00、終了は20:00を超えない', () => {
  const c = candidateStarts(DAY, 30);
  assert.equal(hhmm(c[0].start), '08:00', '最早は08:00');
  assert.equal(hhmm(c[c.length - 1].start), '18:00', '最遅は18:00');
  assert.equal(hhmm(c[c.length - 1].end), '20:00', '最遅枠の終了はちょうど20:00');
  assert.equal(c.length, 21, '30分刻みで21枠');
  for (const s of c) {
    assert.equal(s.end - s.start, LESSON_MINUTES * 60000, '全枠が2時間');
  }
});

test('validateSlotShape が境界を正しく判定する', () => {
  // 正常: 18:00-20:00（終了ちょうど20:00は可）
  assert.deepEqual(validateSlotShape(at('18:00'), at('20:00')), []);
  // 正常: 08:00-10:00
  assert.deepEqual(validateSlotShape(at('08:00'), at('10:00')), []);

  // 08:00より前の開始
  assert.ok(validateSlotShape(at('07:30'), at('09:30')).some((e) => e.includes('8:00')));
  // 20:00を超える終了
  assert.ok(validateSlotShape(at('18:30'), at('20:30')).some((e) => e.includes('20:00')));
  // 2時間でない
  assert.ok(validateSlotShape(at('10:00'), at('11:00')).some((e) => e.includes('2時間')));
  assert.ok(validateSlotShape(at('10:00'), at('13:00')).some((e) => e.includes('2時間')));
  // 不正な値
  assert.ok(validateSlotShape(NaN, at('10:00')).length > 0);
});

// ---------------------------------------------------------------------------
// 運営者手配（固定4時間）— 受入条件「必ず合計4時間を検査する」
// ---------------------------------------------------------------------------

test('運営者手配: 予定が無ければ全21枠が出る', () => {
  const { slots } = operatorArrangedSlots(DAY, []);
  assert.equal(slots.length, 21);
  for (const s of slots) {
    assert.equal(s.arriveBack - s.depart, 4 * 3600000, '占有区間は常に4時間');
    assert.equal(s.outboundMin, FIXED_TRAVEL_MIN);
    assert.equal(s.inboundMin, FIXED_TRAVEL_MIN);
  }
});

test('運営者手配: 要件定義書の例どおりに判定する', () => {
  // 例「10:00〜14:00が空いていれば、11:00〜13:00のレッスンは提示可能」
  // 10:00より前と14:00より後を全部埋める
  const busy = normalizeBusy([busyAt('00:00', '10:00'), busyAt('14:00', '23:59')]);
  const { slots } = operatorArrangedSlots(DAY, busy);
  assert.equal(slots.length, 1);
  assert.equal(hhmm(slots[0].start), '11:00');
  assert.equal(hhmm(slots[0].end), '13:00');
  assert.equal(hhmm(slots[0].depart), '10:00');
  assert.equal(hhmm(slots[0].arriveBack), '14:00');
});

test('運営者手配: 08:00開始には07:00〜11:00の空きが必要', () => {
  // 07:30に30分の予定を置くと08:00開始は不可
  const { slots } = operatorArrangedSlots(DAY, normalizeBusy([busyAt('07:30', '08:00')]));
  assert.ok(!slots.some((s) => hhmm(s.start) === '08:00'), '往路にかかる枠は除外される');
  // 07:00ちょうどに終わる予定なら08:00開始は可（半開区間）
  const ok = operatorArrangedSlots(DAY, normalizeBusy([busyAt('06:00', '07:00')]));
  assert.ok(ok.slots.some((s) => hhmm(s.start) === '08:00'));
});

test('運営者手配: 18:00開始には17:00〜21:00の空きが必要', () => {
  const { slots } = operatorArrangedSlots(DAY, normalizeBusy([busyAt('20:30', '21:00')]));
  assert.ok(!slots.some((s) => hhmm(s.start) === '18:00'), '復路にかかる枠は除外される');
  const ok = operatorArrangedSlots(DAY, normalizeBusy([busyAt('21:00', '22:00')]));
  assert.ok(ok.slots.some((s) => hhmm(s.start) === '18:00'), '21:00開始の予定なら18:00枠は可');
});

test('運営者手配: レッスン中央に予定があれば除外', () => {
  const { slots } = operatorArrangedSlots(DAY, normalizeBusy([busyAt('12:00', '12:15')]));
  // 12:00-12:15 を [D,A) に含む枠は全て消える
  for (const s of slots) {
    assert.ok(!overlaps(s.depart, s.arriveBack, at('12:00'), at('12:15')));
  }
});

// ---------------------------------------------------------------------------
// お客さん指定コート（実経路）
// ---------------------------------------------------------------------------

/** 往路45分・復路60分を返す経路スタブ。 */
const stubTravel = (outboundMin, inboundMin) => async () => ({ outboundMin, inboundMin });

test('お客さん指定: 往復が非対称でも正しく区間を作る', async () => {
  const r = await customerCourtSlots(DAY, [], stubTravel(45, 70), { maxLookups: 50 });
  assert.equal(r.slots.length, 21);
  const first = r.slots[0];
  assert.equal(hhmm(first.start), '08:00');
  assert.equal(hhmm(first.depart), '07:15', '往路45分');
  assert.equal(hhmm(first.arriveBack), '11:10', '復路70分');
});

test('お客さん指定: 経路が取得できない枠は空きにしない', async () => {
  const r = await customerCourtSlots(DAY, [], async () => null, { maxLookups: 50 });
  assert.equal(r.slots.length, 0, '候補は0件');
  assert.equal(r.unresolved, 21, '全件が未解決として報告される');
});

test('お客さん指定: 経路APIの例外は握りつぶさず伝播する', async () => {
  await assert.rejects(
    () => customerCourtSlots(DAY, [], async () => { throw new Error('API down'); }, { maxLookups: 5 }),
    /API down/
  );
});

test('お客さん指定: レッスン本体がbusyなら経路を照会しない（費用の節約）', async () => {
  let calls = 0;
  const lookup = async () => { calls++; return { outboundMin: 30, inboundMin: 30 }; };
  // 終日埋める
  const busy = normalizeBusy([busyAt('00:00', '23:59')]);
  const r = await customerCourtSlots(DAY, busy, lookup, { maxLookups: 50 });
  assert.equal(calls, 0, '1件も照会しない');
  assert.equal(r.slots.length, 0);
  assert.equal(r.lessonFree, 0);
});

test('お客さん指定: 照会上限を超えない（第5-3節）', async () => {
  let calls = 0;
  const lookup = async () => { calls++; return { outboundMin: 30, inboundMin: 30 }; };
  const r = await customerCourtSlots(DAY, [], lookup, { maxLookups: 8 });
  assert.equal(calls, 8, '上限ちょうどで止まる');
  assert.equal(r.lookups, 8);
  assert.equal(r.truncated, true, '打ち切りが呼び出し側に伝わる');
});

test('お客さん指定: 移動時間が長いと往路がbusyに当たって除外される', async () => {
  // 往路120分。08:00開始なら06:00出発。06:30-07:00に予定を置く
  const busy = normalizeBusy([busyAt('06:30', '07:00')]);
  const r = await customerCourtSlots(DAY, busy, stubTravel(120, 30), { maxLookups: 50 });
  assert.ok(!r.slots.some((s) => hhmm(s.start) === '08:00'), '08:00枠は往路が塞がれて除外');
  assert.ok(r.slots.some((s) => hhmm(s.start) === '09:30'), '07:30出発なら可');
});

// ---------------------------------------------------------------------------
// 仮予約のbusy扱い（確認リスト#4 / #5）
// ---------------------------------------------------------------------------

test('相談待ちの仮予約は移動込みで枠を塞ぐ', () => {
  const now = at('09:00');
  const rows = [{
    status: 'pending',
    created_at: new Date(now - 3600000).toISOString(),
    depart_at: toJstIso(at('13:00')),
    arrive_back_at: toJstIso(at('17:00'))
  }];
  const busy = pendingReservationsAsBusy(rows, { now });
  assert.equal(busy.length, 1);

  const { slots } = operatorArrangedSlots(DAY, normalizeBusy(busy));
  // 14:00-16:00 のレッスンは [13:00,17:00) と重なるので出ない
  assert.ok(!slots.some((s) => hhmm(s.start) === '14:00'));
  // 17:00ちょうどから始まる往路（=18:00開始）は可
  assert.ok(slots.some((s) => hhmm(s.start) === '18:00'));
});

test('72時間を過ぎた相談待ちは枠を塞がない', () => {
  const now = at('09:00');
  const rows = [{
    status: 'pending',
    created_at: new Date(now - 73 * 3600000).toISOString(),
    depart_at: toJstIso(at('13:00')),
    arrive_back_at: toJstIso(at('17:00'))
  }];
  assert.equal(pendingReservationsAsBusy(rows, { now, expiryHours: 72 }).length, 0);
});

test('確定・取消の仮予約は pending として扱わない', () => {
  const now = at('09:00');
  const base = {
    created_at: new Date(now).toISOString(),
    depart_at: toJstIso(at('13:00')),
    arrive_back_at: toJstIso(at('17:00'))
  };
  // 取消は枠を塞がない
  assert.equal(pendingReservationsAsBusy([{ ...base, status: 'cancelled' }], { now }).length, 0);
  // 確定はカレンダーに手動登録される運用なので、ここでは pending のみを対象にする
  assert.equal(pendingReservationsAsBusy([{ ...base, status: 'confirmed' }], { now }).length, 0);
});

// ---------------------------------------------------------------------------
// 予約可能期間（確認リスト#1）
// ---------------------------------------------------------------------------

test('予約可能期間は2日後〜30日先', () => {
  const now = jstToEpoch('2026-10-15', 10 * 60);
  assert.equal(isBookableDate('2026-10-15', now), false, '当日は不可');
  assert.equal(isBookableDate('2026-10-16', now), false, '翌日は不可');
  assert.equal(isBookableDate('2026-10-17', now), true, '2日後は可');
  assert.equal(isBookableDate('2026-11-14', now), true, '30日後は可');
  assert.equal(isBookableDate('2026-11-15', now), false, '31日後は不可');
});

test('深夜でも日付の境界がずれない', () => {
  // JST 23:59 と 00:01 で「2日後」が1日ずれないこと
  const late = jstToEpoch('2026-10-15', 23 * 60 + 59);
  assert.equal(isBookableDate('2026-10-17', late), true);
  const early = jstToEpoch('2026-10-16', 1);
  assert.equal(isBookableDate('2026-10-18', early), true);
  assert.equal(isBookableDate('2026-10-17', early), false);
});
