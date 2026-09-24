/**
 * 受付時間の設定（BOOKING_CONFIG）から開始時刻を出すロジックのテスト。
 *
 * apply.html の <script> ブロックから該当部分を取り出して検証する。
 * ブラウザを起動せずに、曜日ごとの時間・固定コート・受付停止日を確かめられる。
 *
 * 実行: node --test tests/booking-hours.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'apply.html'), 'utf8');

// --- apply.html から設定とヘルパ、判定メソッドを取り出す ---------------------

function section(startMarker, endMarker) {
  const a = html.indexOf(startMarker);
  const b = html.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error(`apply.html から取り出せません: ${startMarker}`);
  return html.slice(a, b);
}

const configSrc = section('const BOOKING_CONFIG = {', '/* ---------');
const helperSrc = section('const DOW_KEYS =', 'class Component');
// クラス本体から、判定に関わるメソッドだけを取り出す
const methodsSrc = section('  startTimesFor(dateKey) {', '  buildPicker(i) {');

const factory = new Function(`
  ${configSrc}
  ${helperSrc}
  class Booking {
    ${methodsSrc}
  }
  return { BOOKING_CONFIG, hmToMin, minToHm, dateKeyOf, booking: new Booking() };
`);

const { BOOKING_CONFIG, minToHm, booking } = factory();

/** その日付の開始時刻を 'HH:MM' の配列で得る。 */
const startsOf = (dateKey) => booking.startTimesFor(dateKey).map(minToHm);

// 2026年10月のカレンダー（曜日を固定して検証する）
const MON = '2026-10-05';
const TUE = '2026-10-06';
const WED = '2026-10-07';
const THU = '2026-10-08';
const FRI = '2026-10-09';
const SAT = '2026-10-10';
const SUN = '2026-10-11';

test('検証に使う日付の曜日が想定どおり', () => {
  const dow = (k) => new Date(k + 'T00:00:00').getDay();
  assert.equal(dow(MON), 1); assert.equal(dow(TUE), 2); assert.equal(dow(WED), 3);
  assert.equal(dow(THU), 4); assert.equal(dow(FRI), 5); assert.equal(dow(SAT), 6);
  assert.equal(dow(SUN), 0);
});

// ---------------------------------------------------------------------------
// 曜日ごとの受付時間
// ---------------------------------------------------------------------------

test('月曜 8:00〜12:00 → 8:00〜10:00開始', () => {
  assert.deepEqual(startsOf(MON), ['08:00', '08:30', '09:00', '09:30', '10:00']);
});

test('火曜 12:00〜20:00 → 12:00〜18:00開始', () => {
  const t = startsOf(TUE);
  assert.equal(t[0], '12:00');
  assert.equal(t[t.length - 1], '18:00');
  assert.equal(t.length, 13);
});

test('水曜 8:00〜20:00 → 8:00〜18:00開始', () => {
  const t = startsOf(WED);
  assert.equal(t[0], '08:00');
  assert.equal(t[t.length - 1], '18:00');
  assert.equal(t.length, 21);
});

test('木曜は受付なし', () => {
  assert.deepEqual(startsOf(THU), []);
  assert.equal(booking.isOpenDay(THU), false);
});

test('金曜 13:00〜16:00 → 13:00/13:30/14:00 の3枠だけ', () => {
  assert.deepEqual(startsOf(FRI), ['13:00', '13:30', '14:00']);
});

test('土曜・日曜 12:00〜20:00 → 12:00〜18:00開始', () => {
  for (const day of [SAT, SUN]) {
    const t = startsOf(day);
    assert.equal(t[0], '12:00');
    assert.equal(t[t.length - 1], '18:00');
  }
});

test('レッスン終了が受付終了を超える開始時刻は出さない', () => {
  // 月曜は12:00終了なので、10:30開始（12:30終了）は出てはいけない
  assert.ok(!startsOf(MON).includes('10:30'));
  // 金曜は16:00終了なので、14:30開始（16:30終了）は出てはいけない
  assert.ok(!startsOf(FRI).includes('14:30'));
  // すべての枠で「開始＋2時間 <= 受付終了」が成り立つこと
  for (const [day, endHm] of [[MON, '12:00'], [TUE, '20:00'], [WED, '20:00'], [FRI, '16:00'], [SAT, '20:00'], [SUN, '20:00']]) {
    const endMin = Number(endHm.split(':')[0]) * 60;
    for (const m of booking.startTimesFor(day)) {
      assert.ok(m + BOOKING_CONFIG.lessonMinutes <= endMin, `${day} ${minToHm(m)} が受付時間を超えています`);
    }
  }
});

test('開始時刻は30分刻み', () => {
  for (const m of booking.startTimesFor(WED)) {
    assert.equal(m % BOOKING_CONFIG.stepMinutes, 0);
  }
});

// ---------------------------------------------------------------------------
// 受付停止日
// ---------------------------------------------------------------------------

test('受付停止日に入れた日付は選べなくなる', () => {
  const before = startsOf(WED);
  assert.ok(before.length > 0, '停止前は受付できる');

  BOOKING_CONFIG.blockedDates.push(WED);
  try {
    assert.deepEqual(startsOf(WED), [], '停止日は0枠');
    assert.equal(booking.isOpenDay(WED), false);
    assert.equal(booking.bandLabelFor(WED), '休み');
    // 他の日には影響しない
    assert.ok(startsOf(TUE).length > 0);
  } finally {
    BOOKING_CONFIG.blockedDates.length = 0;
  }
});

test('受付停止日の初期値は空', () => {
  // ここが空でないまま公開すると、意図せず受付できない日ができる
  assert.deepEqual(BOOKING_CONFIG.blockedDates, []);
});

// ---------------------------------------------------------------------------
// 固定コート（金曜＝グリーンテニスプラザ）
// ---------------------------------------------------------------------------

test('金曜は固定コートが返る', () => {
  assert.equal(booking.fixedCourtFor(FRI), 'グリーンテニスプラザ');
});

test('金曜以外は固定コートなし', () => {
  for (const day of [MON, TUE, WED, THU, SAT, SUN]) {
    assert.equal(booking.fixedCourtFor(day), '', `${day} に固定コートが付いています`);
  }
  assert.equal(booking.fixedCourtFor(''), '');
});

test('金曜を選ぶとコート名が自動で入り、予約代行は外れる', () => {
  const data = { date1: { key: FRI, start: 13 * 60 }, court: '', courtReserve: true, courtFixedApplied: false };
  const out = booking.applyFixedCourt(data);
  assert.equal(out.court, 'グリーンテニスプラザ');
  assert.equal(out.courtReserve, false, '固定コートでは予約代行を外す');
  assert.equal(out.courtFixedApplied, true);
});

test('金曜から別の曜日に変えると、自動で入れたコート名は消える', () => {
  let data = booking.applyFixedCourt({ date1: { key: FRI, start: 13 * 60 }, court: '', courtReserve: false, courtFixedApplied: false });
  assert.equal(data.court, 'グリーンテニスプラザ');

  data.date1 = { key: WED, start: 10 * 60 };
  data = booking.applyFixedCourt(data);
  assert.equal(data.court, '', '固定コート名が残らない');
  assert.equal(data.courtFixedApplied, false);
});

test('自分で入力したコート名は、固定コート以外の日で消されない', () => {
  const data = booking.applyFixedCourt({
    date1: { key: WED, start: 10 * 60 }, court: '〇〇公園テニスコート', courtReserve: false, courtFixedApplied: false
  });
  assert.equal(data.court, '〇〇公園テニスコート');
});

// ---------------------------------------------------------------------------
// カレンダーのマス下に出る表示
// ---------------------------------------------------------------------------

test('受付時間の短縮表示', () => {
  assert.equal(booking.bandLabelFor(MON), '8-12');
  assert.equal(booking.bandLabelFor(FRI), '13-16');
  assert.equal(booking.bandLabelFor(THU), '-');
});

// ---------------------------------------------------------------------------
// 旧仕様が残っていないこと
// ---------------------------------------------------------------------------

test('旧 hoursFor（曜日別の固定値）が残っていない', () => {
  assert.ok(!/hoursFor\s*\(/.test(html), 'hoursFor が残っています');
  assert.ok(!html.includes('平日8-19'), '旧い案内文が残っています');
});

test('API連携のコードが残っていない', () => {
  for (const marker of ['/api/availability', '/api/reserve', '/api/court-search']) {
    assert.ok(!html.includes(marker), `${marker} への参照が残っています`);
  }
});

test('LINE公式アカウントのIDとリンク形式', () => {
  assert.ok(html.includes("const LINE_OA_ID = '@950admqv';"), 'LINE_OA_ID が設定されていること');
  assert.ok(html.includes("'https://line.me/R/oaMessage/'"), 'メッセージ送信リンクの形式');
  assert.ok(html.includes("'https://line.me/R/ti/p/'"), '友だち追加リンクの形式');
});

// ---------------------------------------------------------------------------
// LINEリンクの組み立て
// ---------------------------------------------------------------------------

test('LINEのメッセージリンクが正しい形式で、本文が復元できる', () => {
  const OA = '@950admqv';
  const base = 'https://line.me/R/oaMessage/' + encodeURIComponent(OA) + '/?';

  const message = [
    'お申込みの内容をお送りします。',
    '',
    'お名前：山田 太郎',
    'メニュー：対面レッスン',
    '第1希望：10/9(金) 13:00〜15:00(2時間)',
    'コート：グリーンテニスプラザ',
    'ボールレンタル：あり',
    '',
    'よろしくお願いします。'
  ].join('\n');

  const url = base + encodeURIComponent(message);

  assert.ok(url.startsWith('https://line.me/R/oaMessage/%40950admqv/?'), '公式アカウントIDが入る');
  // 本文が欠けずに復元できること（改行・全角も含めて）
  const query = url.slice(url.indexOf('/?') + 2);
  assert.equal(decodeURIComponent(query), message);
  // 生の改行やスペースがURLに混ざっていないこと
  assert.ok(!/[\s]/.test(url), 'URLに空白・改行が含まれない');
});

test('友だち追加リンクの形式', () => {
  const url = 'https://line.me/R/ti/p/' + encodeURIComponent('@950admqv');
  assert.equal(url, 'https://line.me/R/ti/p/%40950admqv');
});

test('完了画面にLINEの緑ボタンと友だち追加ボタンがある', () => {
  assert.ok(html.includes('#06C755'), 'LINEブランドカラー');
  assert.ok(html.includes('LINEで申込内容を送る'), '送信ボタンの文言');
  assert.ok(html.includes('まだ友だち追加していない方はこちら'), '友だち追加ボタン');
  assert.ok(html.includes('{{ lineAddUrl }}'), '友だち追加リンクが差し込まれる');
  assert.ok(html.includes('仮予約を受け付けました'), '仮予約である旨');
  assert.ok(html.includes('予約はまだ確定していません'), '未確定である旨');
});

test('料金は「合計(移動費別)」で、移動費は金額を出さない', () => {
  assert.ok(html.includes("'合計(移動費別)'"), '合計ラベル');
  assert.ok(html.includes("estRows.push({ k: '移動費(お1人分)', v: '別途' })"), '移動費は別途と表示');
  // 移動費に金額を添えていないこと
  assert.ok(!/移動費[^\n]{0,20}[0-9][0-9,]*円/.test(html), '移動費に金額が書かれていない');
});
