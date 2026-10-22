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

test('月曜は午前受付なし。12:00〜20:00 → 12:00〜18:00開始', () => {
  const t = startsOf(MON);
  assert.equal(t[0], '12:00');
  assert.equal(t[t.length - 1], '18:00');
  assert.equal(t.length, 13);
  assert.ok(!t.some((hm) => hm < '12:00'), '午前の枠が出ている');
});

test('火曜 12:00〜20:00 → 12:00〜18:00開始', () => {
  const t = startsOf(TUE);
  assert.equal(t[0], '12:00');
  assert.equal(t[t.length - 1], '18:00');
  assert.equal(t.length, 13);
});

test('水曜は終日受付なし', () => {
  assert.deepEqual(startsOf(WED), []);
  assert.equal(booking.isOpenDay(WED), false);
});

test('木曜は受付なし', () => {
  assert.deepEqual(startsOf(THU), []);
  assert.equal(booking.isOpenDay(THU), false);
});

test('金曜 13:00〜16:00 → 13:00/13:30/14:00 の3枠だけ', () => {
  assert.deepEqual(startsOf(FRI), ['13:00', '13:30', '14:00']);
});

test('土曜・日曜 12:00〜20:00 → 12:00〜18:00開始（日曜午前は受付なし）', () => {
  for (const day of [SAT, SUN]) {
    const t = startsOf(day);
    assert.equal(t[0], '12:00');
    assert.equal(t[t.length - 1], '18:00');
  }
  assert.ok(!startsOf(SUN).some((hm) => hm < '12:00'), '日曜に午前の枠が出ている');
});

test('レッスン終了が受付終了を超える開始時刻は出さない', () => {
  // 月曜は20:00終了なので、18:30開始（20:30終了）は出てはいけない
  assert.ok(!startsOf(MON).includes('18:30'));
  // 金曜は16:00終了なので、14:30開始（16:30終了）は出てはいけない
  assert.ok(!startsOf(FRI).includes('14:30'));
  // すべての枠で「開始＋2時間 <= 受付終了」が成り立つこと
  for (const [day, endHm] of [[MON, '20:00'], [TUE, '20:00'], [FRI, '16:00'], [SAT, '20:00'], [SUN, '20:00']]) {
    const endMin = Number(endHm.split(':')[0]) * 60;
    for (const m of booking.startTimesFor(day)) {
      assert.ok(m + BOOKING_CONFIG.lessonMinutes <= endMin, `${day} ${minToHm(m)} が受付時間を超えています`);
    }
  }
});

test('開始時刻は30分刻み', () => {
  for (const m of booking.startTimesFor(TUE)) {
    assert.equal(m % BOOKING_CONFIG.stepMinutes, 0);
  }
});

// ---------------------------------------------------------------------------
// 受付停止日
// ---------------------------------------------------------------------------

test('受付停止日に入れた日付は選べなくなる', () => {
  const before = startsOf(TUE);
  assert.ok(before.length > 0, '停止前は受付できる');

  BOOKING_CONFIG.blockedDates.push(TUE);
  try {
    assert.deepEqual(startsOf(TUE), [], '停止日は0枠');
    assert.equal(booking.isOpenDay(TUE), false);
    assert.equal(booking.bandLabelFor(TUE), '休み');
    // 他の日には影響しない
    assert.ok(startsOf(SAT).length > 0);
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

  data.date1 = { key: TUE, start: 13 * 60 };
  data = booking.applyFixedCourt(data);
  assert.equal(data.court, '', '固定コート名が残らない');
  assert.equal(data.courtFixedApplied, false);
});

test('自分で入力したコート名は、固定コート以外の日で消されない', () => {
  const data = booking.applyFixedCourt({
    date1: { key: TUE, start: 13 * 60 }, court: '〇〇公園テニスコート', courtReserve: false, courtFixedApplied: false
  });
  assert.equal(data.court, '〇〇公園テニスコート');
});

// ---------------------------------------------------------------------------
// カレンダーのマス下に出る表示
// ---------------------------------------------------------------------------

test('受付時間の短縮表示', () => {
  assert.equal(booking.bandLabelFor(MON), '12-20');
  assert.equal(booking.bandLabelFor(FRI), '13-16');
  assert.equal(booking.bandLabelFor(THU), '-');
  assert.equal(booking.bandLabelFor(WED), '-');
});

// ---------------------------------------------------------------------------
// 旧仕様が残っていないこと
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 申込フォームの項目（年齢・知ったきっかけ）
// ---------------------------------------------------------------------------

test('区分の選択肢が残っておらず、年齢は数字入力になっている', () => {
  for (const old of ['12歳未満', '12〜15歳', '16〜17歳', '18〜22歳', '23歳以上']) {
    assert.ok(!html.includes(old), `旧い区分「${old}」が残っています`);
  }
  assert.ok(html.includes('id="f-age" type="number"'), '年齢の数字入力欄');
  assert.ok(html.includes("age: '', source: ''"), 'state に age / source がある');
});

test('知ったきっかけの選択肢', () => {
  assert.ok(html.includes("this.SOURCES = ['Instagram', 'TikTok', 'Facebook', 'YouTube', '知人の紹介', 'その他'];"));
  assert.ok(html.includes('どこで知りましたか?'));
});

test('年齢の判定（18歳未満は保護者の許可が必要）', () => {
  const ageSrc = section('  ageNumber() {', '  /** 完了画面の黒いカードに出す申込内容。 */');
  const F = new Function(`class A { constructor(age, g) { this.state = { data: { age, guardianConsent: g } }; } ${ageSrc} } return A;`);
  const A = F();
  assert.equal(new A('25', false).ageNumber(), 25);
  assert.equal(new A(' 7 ', true).ageNumber(), 7);
  assert.equal(new A('', false).ageNumber(), null);
  assert.equal(new A('abc', false).ageNumber(), null);
  assert.equal(new A('0', false).ageNumber(), null);
  assert.equal(new A('121', false).ageNumber(), null);
  assert.equal(new A('25', false).ageLabel(), '25歳');
  assert.equal(new A('12', true).ageLabel(), '12歳(保護者の許可あり)');
  assert.equal(new A('12', false).ageLabel(), '12歳');
  assert.equal(new A('', false).ageLabel(), '(未記入)');
});

test('保存する行に age / source が入り、category にも年齢の文字列が入る', () => {
  assert.ok(html.includes('age: this.ageNumber(), source: d.source || null,'));
  assert.ok(html.includes('category: this.ageLabel(),'));
});

test('旧 hoursFor（曜日別の固定値）が残っていない', () => {
  assert.ok(!/hoursFor\s*\(/.test(html), 'hoursFor が残っています');
  assert.ok(!html.includes('平日8-19'), '旧い案内文が残っています');
});

test('API連携のコードが残っていない', () => {
  for (const marker of ['/api/availability', '/api/reserve', '/api/court-search']) {
    assert.ok(!html.includes(marker), `${marker} への参照が残っています`);
  }
});

test('InstagramのIDとDMリンクの形式', () => {
  assert.ok(html.includes("const INSTAGRAM_ID = '@duffy_tennis';"), 'INSTAGRAM_ID が設定されていること');
  assert.ok(html.includes("'https://ig.me/m/' + INSTAGRAM_ID.replace(/^@/, '')"), 'DMリンクの形式');
});

test('LINE公式の導線が残っていない（運用開始まで使わない）', () => {
  for (const marker of ['line.me', 'LINE_OA_ID', 'LINEで申込内容を送る', '友だち追加', 'LINE公式']) {
    assert.ok(!html.includes(marker), `${marker} が残っています`);
  }
});

test('完了画面にInstagram DMの案内とスクリーンショット例がある', () => {
  assert.ok(html.includes('INSTAGRAM DM'), 'DMブロックの見出し');
  assert.ok(html.includes('uploads/dm-example.jpg'), 'DMのスクリーンショット例');
  assert.ok(html.includes('InstagramでDMを送る'), 'DMボタンの文言');
  assert.ok(html.includes('href="{{ dmUrl }}"'), 'DMリンクが差し込まれる');
  assert.ok(html.includes('仮予約を受け付けました'), '仮予約である旨');
  assert.ok(html.includes('予約はまだ確定していません'), '未確定である旨');
});

// ---------------------------------------------------------------------------
// 料金（lib/pricing.js）：2026-10-17 0:00 JST で新料金に切り替わる
// ---------------------------------------------------------------------------

const pricingWindow = {};
new Function('window', readFileSync(join(ROOT, 'lib/pricing.js'), 'utf8'))(pricingWindow);
const PRICING = pricingWindow.DUFFY_PRICING;

test('切り替え時刻は 2026-10-17 0:00（日本時間）', () => {
  assert.equal(PRICING.SWITCH_AT, Date.parse('2026-10-17T00:00:00+09:00'));
});

test('切り替え前は旧料金、以後は新料金', () => {
  const before = PRICING.pricingAt(PRICING.SWITCH_AT - 1);
  const after = PRICING.pricingAt(PRICING.SWITCH_AT);
  assert.deepEqual(before.plans.map((p) => p.price), [2400, 3750, 6500]);
  assert.deepEqual(after.plans.map((p) => p.price), [3300, 4900, 8900]);
  assert.deepEqual(after.plans.map((p) => p.per), [1100, 980, 890]);
  assert.equal(before.lesson.group, null);
  assert.equal(after.lesson.group, 22000);
});

test('対面：1人16,500円、2人以上は人数にかかわらず22,000円', () => {
  const n = PRICING.NEW;
  assert.equal(PRICING.lessonFee(n, 1), 16500);
  for (const people of [2, 3, 4, 5, 6]) assert.equal(PRICING.lessonFee(n, people), 22000);
  assert.equal(PRICING.perPersonLabel(n, 2), '1人11,000円');
  assert.equal(PRICING.perPersonLabel(n, 4), '1人5,500円');
  assert.equal(PRICING.perPersonLabel(n, 3), '約1人7,334円');
  // 旧料金は人数にかかわらず一律
  for (const people of [1, 4]) assert.equal(PRICING.lessonFee(PRICING.OLD, people), 16500);
});

test('ページ側に金額の直書きが残っていない', () => {
  const index = readFileSync(join(ROOT, 'index.html'), 'utf8');
  for (const [name, src] of [['apply.html', html], ['index.html', index]]) {
    assert.ok(src.includes('lib/pricing.js'), `${name} が lib/pricing.js を読んでいない`);
    for (const n of ['16500', '16,500', '2,400', '3,750', '6,500', '22,000', '8,900']) {
      assert.ok(!src.includes(n), `${name} に ${n} の直書きが残っています`);
    }
  }
});

// ---------------------------------------------------------------------------
// セキュリティ：外部スクリプトはバージョン固定＋改ざん検知（SRI）
// ---------------------------------------------------------------------------

test('外部スクリプトはバージョンを固定し、integrity を付けている', () => {
  const index = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const message = readFileSync(join(ROOT, 'message.html'), 'utf8');
  for (const [name, src] of [['apply.html', html], ['index.html', index], ['message.html', message]]) {
    const tags = src.match(/<script[^>]+src="https?:[^"]+"[^>]*>/g) || [];
    for (const tag of tags) {
      assert.ok(!/@\d+\/|@latest|@\d+\.\d+\//.test(tag), `${name}: バージョンが浮いています → ${tag}`);
      assert.ok(/integrity="sha(256|384|512)-/.test(tag), `${name}: integrity がありません → ${tag}`);
      assert.ok(/crossorigin="anonymous"/.test(tag), `${name}: crossorigin がありません → ${tag}`);
    }
  }
});

test('vercel.json にセキュリティヘッダーがある', () => {
  const v = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  const headers = v.headers.flatMap((h) => h.headers).map((h) => h.key.toLowerCase());
  for (const k of ['strict-transport-security', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy']) {
    assert.ok(headers.includes(k), `${k} がありません`);
  }
});

test('料金は「合計(移動費別)」で、移動費は金額を出さない', () => {
  assert.ok(html.includes("'合計(移動費別)'"), '合計ラベル');
  assert.ok(html.includes("estRows.push({ k: '移動費(お1人分)', v: '別途' })"), '移動費は別途と表示');
  // 移動費に金額を添えていないこと
  assert.ok(!/移動費[^\n]{0,20}[0-9][0-9,]*円/.test(html), '移動費に金額が書かれていない');
});
