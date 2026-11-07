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
const methodsSrc = section('  bandFor(dateKey) {', '  buildPicker(i) {');

const factory = new Function(`
  ${configSrc}
  ${helperSrc}
  class Booking {
    ${methodsSrc}
  }
  return { BOOKING_CONFIG, hmToMin, minToHm, dateKeyOf, booking: new Booking() };
`);

const { BOOKING_CONFIG, minToHm, booking } = factory();

/** その日付の受付区分（all / pm / null）。 */
const bandOf = (dateKey) => booking.bandFor(dateKey);

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

test('曜日ごとの受付：月=午後から / 火=終日 / 水=なし / 木=終日 / 金=終日 / 土=終日 / 日=午後から', () => {
  assert.equal(bandOf(MON), 'pm');
  assert.equal(bandOf(TUE), 'all');
  assert.equal(bandOf(WED), null);
  assert.equal(bandOf(THU), 'all');
  assert.equal(bandOf(FRI), 'all');
  assert.equal(bandOf(SAT), 'all');
  assert.equal(bandOf(SUN), 'pm');
  assert.deepEqual(BOOKING_CONFIG.hours, { sun: 'pm', mon: 'pm', tue: 'all', wed: null, thu: 'all', fri: 'all', sat: 'all' });
});

test('水曜だけ選べない。ほかの曜日は選べる', () => {
  assert.equal(booking.isOpenDay(WED), false);
  for (const day of [MON, TUE, THU, FRI, SAT, SUN]) assert.equal(booking.isOpenDay(day), true, `${day} が選べない`);
});

test('時間の選択肢は作らない（開始時刻ボタン・刻み・レッスン長の設定が残っていない）', () => {
  for (const m of ['startTimesFor', 'stepMinutes', 'lessonMinutes', 'hasTimes', 'tempTitle', 'times: times', '開始時刻を選ぶ', 'emptyDay']) {
    assert.ok(!html.includes(m), `${m} が残っています`);
  }
  assert.ok(!/\{ from: '/.test(html), '時刻の範囲（from/to）の設定が残っていない');
});

test('日にちをタップした時点で確定する（時間は選ばない）。選択値は { key } だけ', () => {
  assert.ok(html.includes("['date' + i]: { key: key }"), '日付だけを保存');
  assert.ok(html.includes('第1希望と第2希望が同じ日です'), '同じ日の重複を防ぐ');
});

// ---------------------------------------------------------------------------
// 受付停止日
// ---------------------------------------------------------------------------

test('受付停止日に入れた日付は選べなくなる', () => {
  assert.equal(booking.isOpenDay(TUE), true, '停止前は受付できる');

  BOOKING_CONFIG.blockedDates.push(TUE);
  try {
    assert.equal(bandOf(TUE), null, '停止日は受付なし');
    assert.equal(booking.isOpenDay(TUE), false);
    assert.equal(booking.bandLabelFor(TUE), '休み');
    // 他の日には影響しない
    assert.equal(booking.isOpenDay(SAT), true);
  } finally {
    BOOKING_CONFIG.blockedDates.length = 0;
  }
});

test('受付停止日の初期値は空', () => {
  // ここが空でないまま公開すると、意図せず受付できない日ができる
  assert.deepEqual(BOOKING_CONFIG.blockedDates, []);
});

// ---------------------------------------------------------------------------
// 固定コート（現在はなし。設定を足したときの動きを検証する）
// ---------------------------------------------------------------------------

test('固定コートは設定していない（どの曜日も希望コートを入力する）', () => {
  assert.deepEqual(BOOKING_CONFIG.fixedCourts, {});
  for (const day of [MON, TUE, WED, THU, FRI, SAT, SUN]) {
    assert.equal(booking.fixedCourtFor(day), '', `${day} に固定コートが付いています`);
  }
  assert.equal(booking.fixedCourtFor(''), '');
  assert.ok(!html.includes('グリーンテニスプラザ'), 'グリーンテニスプラザの文言が残っています');
});

test('固定コートを設定すると、その曜日はコート名が自動で入り、予約代行は外れる', () => {
  BOOKING_CONFIG.fixedCourts.fri = 'テストコート';
  try {
    assert.equal(booking.fixedCourtFor(FRI), 'テストコート');
    const out = booking.applyFixedCourt({ date1: { key: FRI, start: 13 * 60 }, court: '', courtReserve: true, courtFixedApplied: false });
    assert.equal(out.court, 'テストコート');
    assert.equal(out.courtReserve, false);
    assert.equal(out.courtFixedApplied, true);
    // 別の曜日に変えると自動で入れたコート名は消える
    const back = booking.applyFixedCourt({ ...out, date1: { key: TUE, start: 13 * 60 } });
    assert.equal(back.court, '');
    assert.equal(back.courtFixedApplied, false);
  } finally {
    delete BOOKING_CONFIG.fixedCourts.fri;
  }
});

test('自分で入力したコート名は消されない', () => {
  const data = booking.applyFixedCourt({
    date1: { key: TUE, start: 13 * 60 }, court: '〇〇公園テニスコート', courtReserve: false, courtFixedApplied: false
  });
  assert.equal(data.court, '〇〇公園テニスコート');
});

// ---------------------------------------------------------------------------
// カレンダーのマス下に出る表示
// ---------------------------------------------------------------------------

test('カレンダーのマス下の表示は「終日」「午後から」「-」。選んだ日程の表記は日にち＋区分', () => {
  assert.equal(booking.bandLabelFor(MON), '午後から');
  assert.equal(booking.bandLabelFor(TUE), '終日');
  assert.equal(booking.bandLabelFor(WED), '-');
  assert.equal(booking.bandLabelFor(SUN), '午後から');
  assert.equal(booking.bandLabelFor(SAT), '終日');
  assert.ok(html.includes("selLine(sel) { return sel ? (this.shortDate(sel.key) + ' ' + this.bandLabelFor(sel.key)) : ''; }"), '確認・メールの表記');
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
  assert.ok(html.includes("sns: '', age: ''"), 'state に age がある');
});

test('「どこで知りましたか？」と電話番号は廃止（入力欄・保存・メール・確認画面・自動保存のどこにもない）', () => {
  for (const m of ['SOURCES', 'sourceOpts', 'どこで知りましたか', '知ったきっかけ', 'f-phone', '電話番号', 'd.phone', 'd.source']) {
    assert.ok(!html.includes(m), `${m} が残っています`);
  }
  // 端末内の自動保存からも外す（古い保存データに残っていても読み込まない）
  assert.ok(html.includes('stripLegacy(data)') && html.includes('delete copy.phone;') && html.includes('delete copy.source;'), '自動保存から除外');
  assert.ok(html.includes('...this.stripLegacy(s.data)') && html.includes('data: this.stripLegacy(patch.data'), '読み込みと保存の両方で除外');
  // メールの変数にも入れない
  const mailParams = section('const emailParams = {', 'message: summary');
  assert.ok(!/phone|source/.test(mailParams), 'メールの変数に phone / source がない');
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

test('保存する行に age が入り、category にも年齢の文字列が入る。phone / source は送らない', () => {
  assert.ok(html.includes('age: this.ageNumber(),'));
  assert.ok(html.includes('category: this.ageLabel(),'));
  const row = section('const row = {', 'estimate: estimate');
  assert.ok(!/phone|source/.test(row), '保存する行に phone / source がない');
  // 列がない場合の保存し直し（フォールバック）は残す
  assert.ok(html.includes("if (!/column|PGRST204/i.test(String(e && e.message))) throw e;"), 'フォールバックの条件');
  assert.ok(html.includes("delete fallback.age;") && html.includes("fallback.question = '[年齢:'"), '年齢を質問欄へ');
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

test('完了画面はDMが最初、Stripeがその下。送る文面は申込内容（メールと同じ）1つだけ', () => {
  assert.ok(html.includes('STEP 1 — INSTAGRAM DM'), 'DMが STEP 1');
  assert.ok(html.includes('STEP 2 — PAYMENT'), 'Stripe が STEP 2');
  assert.ok(html.indexOf('STEP 1 — INSTAGRAM DM') < html.indexOf('STEP 2 — PAYMENT'), 'DM ブロックが先に出る');
  assert.ok(html.includes('「申込完了」と申込内容を送ってください'), 'DMで送る内容の指示');
  assert.ok(html.includes("return ['申込完了しました。', '', this.buildSummary().split('\\n----')[0].trim(), '', 'よろしくお願いします。'].join('\\n');"), 'DMの文面はメールと同じ申込内容');
  assert.ok(!html.includes('申込内容の控え') && !html.includes('dmShortMessage'), '控えの箱と短い文面は1つにまとめた');
  assert.equal((html.match(/\{\{ lineMessage \}\}/g) || []).length, 1, '文面の表示は1か所');
  assert.ok(html.includes('uploads/dm-example.jpg') && !html.includes('DMの送り方の例を見る'), 'DMの画像は折りたたまずに見せる');
  assert.ok(!html.includes('確認用の控えを保存できませんでした'), '保存失敗の注意は出さない');
  assert.ok(html.includes('同じ内容の確認メールを {{ mailTo }} にお送りしました'), '確認メールの案内');
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

test('検索向けの設定：日本語タイトル・説明・OGP・canonical が各ページにある', () => {
  const index = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const message = readFileSync(join(ROOT, 'message.html'), 'utf8');
  for (const [name, src] of [['apply.html', html], ['index.html', index], ['message.html', message]]) {
    assert.ok(src.includes('<html lang="ja">'), `${name}: lang="ja"`);
    assert.ok(/<title>[^<]*ダッフィーテニス[^<]*<\/title>/.test(src), `${name}: タイトルに「ダッフィーテニス」`);
    assert.ok(/<meta name="description" content="[^"]{40,}"/.test(src), `${name}: description`);
    assert.ok(/<link rel="canonical" href="https:\/\/duffy-tennis\.pages\.dev\//.test(src), `${name}: canonical`);
    for (const p of ['og:title', 'og:description', 'og:image', 'twitter:card']) {
      assert.ok(src.includes(`property="${p}"`) || src.includes(`name="${p}"`), `${name}: ${p}`);
    }
  }
  assert.ok(index.includes('application/ld+json'), 'index.html: 構造化データ');
  assert.ok(index.includes('ダッフィーテニス ／ ダッフィー先生のテニスレッスン'), 'index.html: 本文に屋号');
});

test('robots.txt / sitemap.xml / _headers がある', () => {
  const robots = readFileSync(join(ROOT, 'robots.txt'), 'utf8');
  assert.ok(robots.includes('Sitemap: https://duffy-tennis.pages.dev/sitemap.xml'));
  const sitemap = readFileSync(join(ROOT, 'sitemap.xml'), 'utf8');
  for (const p of ['/', '/apply', '/message']) assert.ok(sitemap.includes('https://duffy-tennis.pages.dev' + p + '<'));
  const headers = readFileSync(join(ROOT, '_headers'), 'utf8');
  for (const k of ['Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy']) {
    assert.ok(headers.includes(k), `_headers に ${k} がありません`);
  }
});

test('vercel.json は Cloudflare へ全ページ転送するだけ（Vercel での公開は停止）', () => {
  const v = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  assert.equal(v.redirects.length, 1);
  assert.equal(v.redirects[0].source, '/(.*)');
  assert.equal(v.redirects[0].destination, 'https://duffy-tennis.pages.dev/$1');
  assert.equal(v.redirects[0].permanent, true);
});

// ---------------------------------------------------------------------------
// Stripe の支払いリンク（lib/payments.js）
// ---------------------------------------------------------------------------

const payWindow = {};
new Function('window', readFileSync(join(ROOT, 'lib/payments.js'), 'utf8'))(payWindow);
const PAY = payWindow.DUFFY_PAYMENTS;

test('チケット3種類すべてに支払いリンクがある（置き換え忘れなし）', () => {
  for (const k of ['3', '5', '10']) {
    const u = PAY.PAYMENTS.tickets[k];
    assert.ok(/^https:\/\/buy\.stripe\.com\/[A-Za-z0-9_]+$/.test(u), `${k}回: ${u}`);
    assert.ok(!u.includes('REPLACE'), `${k}回のリンクが未設定`);
  }
});

test('本番リンクに test_ が混ざっておらず、テストリンクは test_ で始まる', () => {
  for (const k of ['3', '5', '10']) {
    assert.ok(!PAY.PAYMENTS.tickets[k].includes('/test_'), `${k}回の本番リンクが test_`);
    assert.ok(PAY.PAYMENTS.testTickets[k].includes('/test_'), `${k}回のテストリンクが test_ ではない`);
  }
  assert.equal(PAY.PAYMENTS.mode, 'live', '公開中は live のはず');
});

test('enabled が false のあいだは支払いURLを返さない（DM案内に戻る）', () => {
  const saved = PAY.PAYMENTS.enabled;
  PAY.PAYMENTS.enabled = false;
  try {
    assert.equal(PAY.ticketUrl('10', 'taro@example.com', '山田 太郎'), '');
  } finally {
    PAY.PAYMENTS.enabled = saved;
  }
});

test('支払いURLにメールと氏名が付く', () => {
  const saved = PAY.PAYMENTS.enabled;
  PAY.PAYMENTS.enabled = true;
  const u = PAY.ticketUrl('10', 'taro@example.com', '山田 太郎');
  PAY.PAYMENTS.enabled = saved;
  assert.ok(u.startsWith(PAY.PAYMENTS.tickets['10'] + '?'));
  assert.ok(u.includes('prefilled_email=taro%40example.com'));
  assert.ok(u.includes('client_reference_id='));
  PAY.PAYMENTS.enabled = true;
  assert.equal(PAY.ticketUrl('99', 'a@b.c', 'x'), '', '存在しないプランは空');
  assert.equal(PAY.ticketUrl('10'), PAY.PAYMENTS.tickets['10'], '引数なしならそのまま');
  PAY.PAYMENTS.enabled = saved;
});

test('申込フォームに Stripe の支払いボタンが組み込まれている', () => {
  assert.ok(html.includes('lib/payments.js'));
  assert.ok(html.includes('Stripeで支払う'));
  assert.ok(html.includes("showPay: st.done && d.menu === 'online'"));
});

test('金額は「お支払い金額(移動費別)」で、移動費は金額を出さない。「合計」の表記は使わない', () => {
  assert.ok(html.includes("'お支払い金額(移動費別)'"), '金額ラベル');
  assert.ok(html.includes("estRows.push({ k: '移動費(お1人分)', v: '別途' })"), '移動費は別途と表示');
  assert.ok(!/移動費[^\n]{0,20}[0-9][0-9,]*円/.test(html), '移動費に金額が書かれていない');
  // 規約本文（変更しない）以外に「合計」が出ていない
  const idx = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const g = readFileSync(join(ROOT, 'guide.html'), 'utf8');
  assert.ok(!idx.includes('合計') && !g.includes('合計'), 'トップ・ガイドに「合計」がない');
  assert.ok(!html.replace(/参加人数にかかわらず合計/g, '').includes('合計'), '申込フォームに「合計」がない（規約本文を除く）');
});

// ---------------------------------------------------------------------------
// 申込導線（2026-11-08）：4ステップ、年齢・きっかけは任意、Instagram 必須、規約は要点＋全文
// ---------------------------------------------------------------------------

test('申込フォームは4ステップ（メニュー→プラン・日程→基本情報→確認）', () => {
  assert.ok(html.includes("const labels = ['メニュー', 'プラン・日程', '基本情報', '確認'];"), 'ステップ名');
  assert.ok(html.includes('全4ステップ・約2分'), 'トップの案内文');
  assert.ok(!html.includes('isStep5'), '5ステップ目が残っていない');
  assert.ok(html.includes("nextLabel: st.step === 4 ? (st.sending ? '送信中…' : (this.isWaitlist() ? 'ウェイティングリストに登録する' : '送信する →')) : '次へ →'"), '4ステップ目で送信');
  assert.ok(/if \(st\.step === 4\) \{\s*this\.setState\(\{ sending: true/.test(html), '送信は4ステップ目');
  // メニュー → プラン・日程 → 基本情報 → 確認 の順で markup が並ぶ
  const i1 = html.indexOf('<sc-if value="{{ isStep1 }}"'), i2 = html.indexOf('<sc-if value="{{ isStep2 }}"');
  const i3 = html.indexOf('<sc-if value="{{ isStep3 }}"'), i4 = html.indexOf('<sc-if value="{{ isStep4 }}"');
  assert.ok(i1 < i2 && i2 < i3 && i3 < i4, 'ステップの並び');
  assert.ok(html.slice(i1, i2).includes('menuCards'), '1はメニュー');
  assert.ok(html.slice(i2, i3).includes('planCards') && html.slice(i2, i3).includes('rentalOpts'), '2はプラン・日程・ボール');
  assert.ok(html.slice(i3, i4).includes('fields1') && html.slice(i3, i4).includes('id="q"'), '3は基本情報＋質問');
  assert.ok(html.slice(i4).includes('confirmRows') && html.slice(i4).includes('onAgree'), '4は規約＋確認');
});

test('必須は氏名とメールだけ（Instagram・電話・年齢・きっかけは任意）', () => {
  assert.ok(/key: 'name'[^\n]*req: true/.test(html) && /key: 'email'[^\n]*req: true/.test(html), '氏名・メールは必須');
  assert.ok(/key: 'sns'[^\n]*req: false/.test(html), 'Instagramは任意');
  assert.ok(html.includes("if (!d.name.trim()) return '氏名を入力してください。';"), '氏名の検証');
  assert.ok(!html.includes("if (!d.sns.trim())"), 'Instagramの必須チェックがない');
  assert.ok(html.includes("if (String(d.age).trim() !== '') {"), '年齢は入力があるときだけ検証');
  assert.ok(!html.includes("return 'どこで知ったかを選択してください。';") && !html.includes("if (!d.source)"), 'きっかけ必須が消えている');
  assert.ok(html.includes("if (age < 18 && !d.guardianConsent)"), '17歳以下だけ保護者確認');
});

test('規約は要点4行＋全文の折りたたみ、同意は必須のまま', () => {
  assert.ok(html.includes('レッスン利用規約の要点'), '要点の見出し');
  assert.ok(html.includes('実施日の3日前まで無料、前日まで50%、当日100%'), 'キャンセル料');
  assert.ok(html.includes('購入日から5ヶ月有効で、原則返金はありません'), 'チケット有効期限');
  assert.ok(html.includes("'全文を読む（第1〜14条）'"), '全文トグル');
  assert.ok(html.includes('第14条(準拠法および協議)') && html.includes('第1条(本規約への同意)'), '全文が残っている');
  assert.ok(html.includes("if (!d.agree) return '規約への同意が必要です。';"), '同意必須');
});

test('支払い方法の質問は出さない（オンライン・対面とも Stripe）', () => {
  assert.ok(html.includes("this.setData({ menu: c.key, payment: this.PAY_LABEL })"), 'メニューで支払い方法が決まる');
  assert.ok(!html.includes('paymentOpts') && !html.includes('お支払い方法を選択してください'), '支払い方法の選択がない');
  assert.ok(html.includes("if (!d.agree) return '規約への同意が必要です。';"), '規約の同意は必須');
});

test('トップのヒーローは申込ボタン2つ（?menu= 付き）。金額は lib/pricing.js から描画。旧い表記がない', () => {
  const idx = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.ok(idx.includes('href="apply.html?menu=online"') && idx.includes('{{ heroOnlineLabel }}'), '主ボタン（オンライン）');
  assert.ok(idx.includes('href="apply.html?menu=inperson"') && idx.includes('{{ heroOfflineLabel }}'), '副ボタン（対面）');
  assert.ok(idx.includes("heroOnlineLabel: 'オンライン動画添削を申し込む（' + P.plans[0].key + '回 ' + yen(P.plans[0].price) + '円〜）'"), 'オンラインの金額は pricing から');
  assert.ok(idx.includes("heroOfflineLabel: '対面レッスンを申し込む（120分 ' + yen(P.lesson.solo) + '円）'"), '対面の金額は pricing から');
  // 2ボタンの下にテキストリンク
  assert.ok(idx.indexOf('{{ heroOfflineLabel }}') < idx.indexOf('料金と申込方法 →'), '料金と申込方法のリンクは2ボタンの下');
  for (const m of ['5ステップ', '5 STEPS', '約3分', 'line.me', '申込はこちら →']) assert.ok(!idx.includes(m), `${m} が残っています`);
  assert.ok(!/(^|[^A-Z])LINE([^A-Z]|$)/.test(idx), 'LINE（単語）が残っています');
  assert.ok(idx.includes("href: 'guide.html'"), 'メニューにガイド');
});

test('/guide（料金と申込方法）がある：料金表・流れ・FAQ、公開リストと sitemap に入っている', () => {
  const g = readFileSync(join(ROOT, 'guide.html'), 'utf8');
  assert.ok(g.includes('一番人気'), '5回に一番人気');
  for (const m of ['3,300', '4,900', '8,900', '16,500', '22,000', '申込完了', 'ig.me/m/duffy_tennis', 'よくある質問', 'apply.html']) {
    assert.ok(g.includes(m), `${m} がガイドにない`);
  }
  for (const m of ['line.me', '感覚']) assert.ok(!g.includes(m), `${m} がガイドに残っています`);
  assert.ok(!/(^|[^A-Z])LINE([^A-Z]|$)/.test(g), 'LINE（単語）がガイドに残っています');
  assert.ok(readFileSync(join(ROOT, 'scripts/build.mjs'), 'utf8').includes("'guide.html'"), 'build の公開リスト');
  assert.ok(readFileSync(join(ROOT, 'sitemap.xml'), 'utf8').includes('/guide</loc>'), 'sitemap');
});

test('5回チケットに「一番人気」', () => {
  const src = readFileSync(join(ROOT, 'lib/pricing.js'), 'utf8');
  assert.ok(src.includes("{ key: '5', price: 4900, per: 980, badge: '一番人気', popular: true }"), 'pricing.js');
  assert.ok(readFileSync(join(ROOT, 'index.html'), 'utf8').includes('{{ p.popular }}'), 'トップの料金表');
});

// ---------------------------------------------------------------------------
// 2026-11-08 改修：?menu= の事前選択、受付枠（残り◯名／ウェイティング）、支払い表記の統一、戻るリンク、解析
// ---------------------------------------------------------------------------

test('?menu=online / ?menu=inperson でメニューを選択済みにして1ステップ目から始める', () => {
  assert.ok(html.includes("new URLSearchParams(window.location.search).get('menu')"), 'クエリを読む');
  assert.ok(html.includes("{ online: 'online', inperson: 'offline', offline: 'offline' }[q]"), 'inperson → 内部の offline');
  assert.ok(/step: 1,\s*\n\s*data: \{ \.\.\.this\.state\.data, menu, payment: this\.PAY_LABEL \}/.test(html), '選択済み・1ステップ目');
});

const availWindow = {};
new Function('window', readFileSync(join(ROOT, 'lib/availability.js'), 'utf8'))(availWindow);
const AV = availWindow.DUFFY_AVAILABILITY;
const NOV = Date.parse('2026-11-15T12:00:00+09:00');

test('受付枠：残り = capacity - accepted。設定は1か所', () => {
  assert.deepEqual(Object.keys(AV.AVAILABILITY), ['online'], '管理するのはオンラインだけ');
  assert.deepEqual(Object.keys(AV.AVAILABILITY.online).sort(), ['accepted', 'capacity', 'month']);
  AV.AVAILABILITY.online = { capacity: 10, accepted: 3, month: '2026-11' };
  const st = AV.status('online', NOV);
  assert.equal(st.remaining, 7); assert.equal(st.active, true); assert.equal(st.full, false);
  AV.AVAILABILITY.online = { capacity: 10, accepted: 10, month: '2026-11' };
  const full = AV.status('online', NOV);
  assert.equal(full.remaining, 0); assert.equal(full.full, true);
  AV.AVAILABILITY.online = { capacity: 10, accepted: 12, month: '2026-11' };
  assert.equal(AV.status('online', NOV).remaining, 0, '超過しても 0 止まり');
});

test('受付枠：月が違うと表示も満席判定もしない（古い数字を出さない）。月は日本時間で判定', () => {
  AV.AVAILABILITY.online = { capacity: 10, accepted: 10, month: '2026-11' };
  const dec = AV.status('online', Date.parse('2026-12-01T00:00:00+09:00'));
  assert.equal(dec.active, false); assert.equal(dec.full, false);
  assert.equal(AV.status('online', Date.parse('2026-11-30T23:59:00+09:00')).full, true, '日本時間の月末はまだ11月');
  assert.equal(AV.status('event', NOV).active, false, '設定のないメニューは対象外');
});

test('残枠表示：トップ（ONLINE）と申込フォーム（プラン選択）に出る。対面には出さない', () => {
  const idx = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.ok(idx.includes("window.DUFFY_AVAILABILITY.status('online')") && idx.includes("'今月 残り' + A.remaining + '名'"), 'トップの表示');
  assert.ok(idx.includes('{{ onlineRemaining }}'), 'トップの差し込み');
  assert.ok(html.includes("remainingText: '今月 残り' + this.AVAIL.remaining + '名'"), '申込フォームの表示');
  const i2 = html.indexOf('<sc-if value="{{ isStep2 }}"');
  const online = html.indexOf('<sc-if value="{{ isOnline }}"', i2);
  const offline = html.indexOf('<sc-if value="{{ isOffline }}"', online);
  assert.ok(html.indexOf('{{ remainingText }}') > online && html.indexOf('{{ remainingText }}') < offline, '残枠はオンラインのプラン選択の中');
  assert.ok(!/AVAIL[^\n]*offline|status\('offline'\)|status\('inperson'\)/.test(html), '対面の受付数は管理しない');
});

test('満席のとき：ボタンはウェイティングリスト登録、完了画面は順番待ち、決済ボタンは出ない', () => {
  assert.ok(html.includes("'ウェイティングリストに登録する'"), '送信ボタン');
  assert.ok(html.includes("this.isWaitlist() ? 'ウェイティングリストに登録しました。' : '仮予約を受け付けました。'"), '完了画面の見出し');
  assert.ok(html.includes('順番が来るまで、予約もお支払いも確定しません。'), '完了画面の説明');
  assert.ok(/if \(d\.menu !== 'online' \|\| !d\.plan \|\| this\.isWaitlist\(\)\) return '';/.test(html), '満席なら支払いURLを返さない（決済ボタン・メールのリンクが消える）');
  assert.ok(html.includes("showPay: st.done && d.menu === 'online' && !!this.payUrl()"), '決済ボタンは payUrl があるときだけ');
  assert.ok(html.includes("'オンライン動画添削(ウェイティングリスト)'"), '通知メールの件名側でも分かる');
  assert.ok(html.includes("question: this.isWaitlist() ? '[ウェイティングリスト登録]' + (d.question ? '\\n' + d.question : '') : d.question"), '保存データにも印を残す');
});

test('支払い表記は「お支払い：Stripe（カード／Apple Pay／Google Pay／PayPay）」に統一', () => {
  const PAY = 'お支払い：Stripe（カード／Apple Pay／Google Pay／PayPay）';
  const g = readFileSync(join(ROOT, 'guide.html'), 'utf8');
  const t = readFileSync(join(ROOT, 'tokushoho.html'), 'utf8');
  assert.ok(html.includes(PAY) && g.includes(PAY), '申込フォームとガイドに同じ表記');
  assert.ok(t.includes('Stripe（カード／Apple Pay／Google Pay／PayPay）'), '特商法表記');
  for (const [name, src] of [['apply.html', html], ['guide.html', g]]) {
    for (const old of ['カード決済（Stripe）', 'Stripe（カード・PayPay）', 'クレジットカード(Stripe)', 'カード・Apple Pay・Google Pay が使えます']) {
      assert.ok(!src.includes(old), `${name} に旧い表記「${old}」が残っています`);
    }
    assert.ok(!/口座振り込み|銀行振込による支払/.test(src.replace(/お支払いを銀行振込により行う場合、振込手数料はお客様のご負担とします。/g, '')), `${name} に銀行振込の案内がない`);
  }
});

test('申込フォーム冒頭の「戻る」リンクは申込完了後だけ。ガイドは残し、料金表の前に申込ボタン', () => {
  const head = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.ok(/<sc-if value="\{\{ done \}\}"[^>]*>\s*<a href="index\.html"[^>]*>← MatchUpへ戻る<\/a>\s*<\/sc-if>/.test(head), '完了後だけ表示');
  const g = readFileSync(join(ROOT, 'guide.html'), 'utf8');
  assert.ok(g.includes('<header><a href="index.html">← MatchUpへ戻る</a>'), 'ガイドの戻るリンクは残す');
  const price = g.indexOf('<h2>料金表</h2>');
  const firstTable = g.indexOf('<div class="tbl">', price);
  const btn = g.indexOf('href="apply.html">申込フォームへ →</a>', price);
  assert.ok(btn > price && btn < firstTable, '料金表の直前に申込ボタン');
});

test('解析：トークン1か所の定数。空なら読み込まない。3ページから読み込み、プライバシーに明記', () => {
  const src = readFileSync(join(ROOT, 'lib/analytics.js'), 'utf8');
  assert.equal((src.match(/var CF_ANALYTICS_TOKEN = /g) || []).length, 1, 'トークンの定義は1か所');
  assert.ok(src.includes('if (!CF_ANALYTICS_TOKEN') && src.includes('https://static.cloudflareinsights.com/beacon.min.js'), '空なら何もしない／Cloudflare のビーコン');
  assert.ok(!/email|name|phone|sns/i.test(src.replace(/\/\/.*$/gm, '')), '個人情報を渡す記述がない');
  for (const f of ['index.html', 'apply.html', 'guide.html']) assert.ok(/lib\/analytics\.js/.test(readFileSync(join(ROOT, f), 'utf8')), `${f} が読み込む`);
  const pv = readFileSync(join(ROOT, 'privacy.html'), 'utf8');
  assert.ok(pv.includes('Cloudflare Web Analytics'), 'プライバシーに解析の記載');
  assert.ok(!pv.includes('電話番号'), 'プライバシーの取得情報から電話番号を削除');
});

test('申込フォームのロゴ（MatchUp）は常にトップへのリンク', () => {
  const head = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.ok(/<a href="index\.html"[^>]*>MatchUp<\/a>/.test(head), 'ロゴがリンク');
});

test('トップのヘッダー（MatchUp＋三本線）は固定で追従し、黒背景・白文字・白い三本線。申込フォームには付けない', () => {
  const idx = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const head = idx.slice(idx.indexOf('<header class="site-header"'), idx.indexOf('</header>'));
  assert.ok(/position:fixed;top:0;left:0;right:0/.test(head), '固定表示');
  assert.ok(head.includes('background:#111111') && head.includes('color:#FFFFFF'), '黒背景・白文字');
  assert.ok(idx.includes("burgerBar: '#FFFFFF'"), '三本線は白');
  assert.ok(!html.includes('site-header') && !html.includes('position:fixed;top:0;left:0;right:0'), '申込フォームは固定ヘッダーなし');
});
