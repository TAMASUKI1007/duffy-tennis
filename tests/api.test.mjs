/**
 * APIハンドラのエンドツーエンドテスト（要件定義書 第8節・第9節）。
 *
 * 外部サービス（Google認証・カレンダー・NAVITIME・Supabase）は globalThis.fetch を
 * 差し替えて再現する。モジュールのモックを使わないので、実際に本番で通るコード経路を
 * そのまま検証できる。
 *
 * 実行: node --test tests/api.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { generateKeyPairSync } from 'node:crypto';

import { jstToEpoch, toJstIso, epochToJst } from '../api/_lib/slots.mjs';
import { _clearCache } from '../api/_lib/routes.mjs';
import { _resetAuthCache } from '../api/_lib/google-calendar.mjs';

// --- 環境変数（本物の鍵は使わない。テスト用に生成した鍵で署名だけ通す） ---
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });

process.env.GOOGLE_SA_CLIENT_EMAIL = 'test@example.iam.gserviceaccount.com';
process.env.GOOGLE_SA_PRIVATE_KEY = TEST_PRIVATE_KEY;
process.env.GOOGLE_CALENDAR_IDS = 'primary';
process.env.RAPIDAPI_KEY = 'test-key';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.LINE_OA_ID = '@test-oa';
process.env.GOOGLE_MAPS_API_KEY = 'test-maps-key';

const availability = (await import('../api/availability.mjs')).default;
const reserve = (await import('../api/reserve.mjs')).default;

// ---------------------------------------------------------------------------
// テスト用の req / res
// ---------------------------------------------------------------------------

// テストごとに別IPを使う。連投対策(throttle)がテスト間で干渉しないようにするため。
let ipSeq = 0;
function nextIp() { ipSeq++; return `10.1.${Math.floor(ipSeq / 254)}.${(ipSeq % 254) + 1}`; }

function makeReq(body, { ip = nextIp(), method = 'POST' } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
  req.method = method;
  req.headers = { 'x-forwarded-for': ip };
  return req;
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(s) { this.body = JSON.parse(s); }
  };
}

async function call(h, body, opts) {
  const res = makeRes();
  await h(makeReq(body, opts), res);
  return res;
}

// ---------------------------------------------------------------------------
// 外部サービスの再現
// ---------------------------------------------------------------------------

/** 2日後〜30日先に必ず入る日付を取る。 */
function targetDate(offsetDays = 7) {
  return epochToJst(Date.now() + offsetDays * 86400000).date;
}

let scenario;

function installFetch() {
  globalThis.fetch = async (url, init) => {
    const u = String(url);

    const json = (obj, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => obj,
      text: async () => JSON.stringify(obj)
    });

    if (u.includes('oauth2.googleapis.com/token')) {
      if (scenario.authFails) return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: 'test-token', expires_in: 3600 });
    }

    if (u.includes('calendar/v3/freeBusy')) {
      if (scenario.calendarFails) return json({ error: {} }, 500);
      if (scenario.calendarNotShared) {
        return json({ calendars: { primary: { errors: [{ reason: 'notFound' }] } } });
      }
      return json({ calendars: { primary: { busy: scenario.busy || [] } } });
    }

    if (u.includes('route_transit')) {
      if (scenario.routeFails) return json({ message: 'error' }, 500);
      if (scenario.routeEmpty) return json({ items: [] });
      const minutes = u.includes('goal_time') ? (scenario.outboundMin ?? 45) : (scenario.inboundMin ?? 50);
      return json({
        items: [{
          summary: { move: { time: minutes, fare: { unit_0: 480 }, transit_count: 1 } },
          sections: [{ type: 'move', move: 'walk' }, { type: 'move', move: 'local_train' }]
        }]
      });
    }

    if (u.includes('/rest/v1/applications')) {
      const method = (init && init.method) || 'GET';
      if (method === 'GET') {
        // 重複チェック or 相談待ちの取得
        if (u.includes('lesson_start_at=eq.')) return json(scenario.duplicate ? [scenario.duplicate] : []);
        return json(scenario.pending || []);
      }
      if (method === 'POST') {
        if (scenario.saveFails) return json({ message: 'db down' }, 500);
        scenario.saved = JSON.parse(init.body);
        return json([scenario.saved]);
      }
      return json([]);
    }

    throw new Error('想定外のfetch: ' + u);
  };
}

test.beforeEach(() => {
  scenario = {};
  _clearCache();
  _resetAuthCache();
  installFetch();
});

// ---------------------------------------------------------------------------
// /api/availability
// ---------------------------------------------------------------------------

test('運営者手配: 予定が無ければ21枠が返る', async () => {
  const date = targetDate();
  const res = await call(availability, { mode: 'operator', date });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.slots.length, 21);
  assert.equal(res.body.slots[0].label, '08:00〜10:00');
  assert.equal(res.body.diagnostics.lookups, 0, '経路APIは呼ばない');
});

test('運営者手配: busy予定が往路にかかる枠を除外する', async () => {
  const date = targetDate();
  // 07:30-08:00 に予定 → 08:00開始(07:00出発)は不可
  scenario.busy = [{
    start: toJstIso(jstToEpoch(date, 7 * 60 + 30)),
    end: toJstIso(jstToEpoch(date, 8 * 60))
  }];
  const res = await call(availability, { mode: 'operator', date });
  assert.ok(!res.body.slots.some((s) => s.label.startsWith('08:00')), '08:00枠は出ない');
  assert.ok(res.body.slots.some((s) => s.label.startsWith('09:30')), '09:30枠は出る');
});

test('カレンダーが取れないときは空き0件ではなく503を返す（第8節）', async () => {
  scenario.calendarFails = true;
  const res = await call(availability, { mode: 'operator', date: targetDate() });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'calendar_unavailable');
  assert.ok(!('slots' in res.body), '候補を返さない');
});

test('カレンダーの共有が外れている場合も空きとして扱わない', async () => {
  scenario.calendarNotShared = true;
  const res = await call(availability, { mode: 'operator', date: targetDate() });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'calendar_unavailable');
});

test('Google認証が失敗したら空きとして扱わない', async () => {
  scenario.authFails = true;
  const res = await call(availability, { mode: 'operator', date: targetDate() });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'calendar_unavailable');
});

test('お客さん指定: 経路の往復が非対称でも枠が出る／照会上限を超えない', async () => {
  scenario.outboundMin = 45;
  scenario.inboundMin = 70;
  const res = await call(availability, {
    mode: 'customer', date: targetDate(), courtCoord: '35.630000,139.790000'
  });
  assert.equal(res.body.ok, true);
  assert.ok(res.body.slots.length > 0);
  assert.equal(res.body.slots[0].outboundMin, 45);
  assert.equal(res.body.slots[0].inboundMin, 70);
  assert.ok(res.body.diagnostics.lookups <= 10, `照会枠数が上限内 (${res.body.diagnostics.lookups})`);
});

test('お客さん指定: 経路サービスが落ちていたら503（候補なしと区別する）', async () => {
  scenario.routeFails = true;
  const res = await call(availability, {
    mode: 'customer', date: targetDate(), courtCoord: '35.630000,139.790000'
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'route_unavailable');
});

test('お客さん指定: 運行が無い時刻は候補にせず、案内文を返す', async () => {
  scenario.routeEmpty = true;
  const res = await call(availability, {
    mode: 'customer', date: targetDate(), courtCoord: '35.630000,139.790000'
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.slots.length, 0);
  assert.ok(res.body.notices.join('').includes('LINE'), 'LINE相談を案内する');
});

test('関東の外の座標は受け付けない', async () => {
  const res = await call(availability, {
    mode: 'customer', date: targetDate(), courtCoord: '34.693700,135.502200' // 大阪
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /コート/);
});

test('受付対象外の日付を弾く（当日・31日先）', async () => {
  const today = epochToJst(Date.now()).date;
  const r1 = await call(availability, { mode: 'operator', date: today });
  assert.equal(r1.statusCode, 400);

  const far = epochToJst(Date.now() + 31 * 86400000).date;
  const r2 = await call(availability, { mode: 'operator', date: far });
  assert.equal(r2.statusCode, 400);
});

test('相談待ちの仮予約が枠を塞ぐ', async () => {
  const date = targetDate();
  scenario.pending = [{
    status: 'pending',
    created_at: new Date().toISOString(),
    depart_at: toJstIso(jstToEpoch(date, 13 * 60)),
    arrive_back_at: toJstIso(jstToEpoch(date, 17 * 60))
  }];
  const res = await call(availability, { mode: 'operator', date });
  assert.ok(!res.body.slots.some((s) => s.label.startsWith('14:00')), '重なる枠は出ない');
});

// ---------------------------------------------------------------------------
// /api/reserve
// ---------------------------------------------------------------------------

const baseApplicant = {
  mode: 'operator',
  name: '山田 太郎',
  email: 'test@example.com',
  phone: '09012345678',
  sns: '@yamada',
  category: '18歳以上',
  people: 1,
  rental: 'なし',
  payment: '現地払い',
  agree: true
};

test('仮予約: 正常に保存され、受付番号とLINEリンクが返る', async () => {
  const date = targetDate();
  const start = toJstIso(jstToEpoch(date, 10 * 60));
  const res = await call(reserve, { ...baseApplicant, choice1: start });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.referenceCode, /^DT-\d{6}-[A-Z0-9]{4}$/);
  assert.ok(res.body.lineUrl.startsWith('https://line.me/R/oaMessage/'), 'LINEリンク形式');
  assert.ok(decodeURIComponent(res.body.lineUrl).includes(res.body.referenceCode), '本文に受付番号が入る');

  // 保存内容の検証
  assert.equal(scenario.saved.status, 'pending');
  assert.equal(scenario.saved.lesson_start_at, start);
  assert.equal(scenario.saved.court_arranger, 'operator');
  // 移動込みの区間が保存されている（手動登録支援のため）
  assert.equal(epochToJst(Date.parse(scenario.saved.depart_at)).hhmm, '09:00');
  assert.equal(epochToJst(Date.parse(scenario.saved.arrive_back_at)).hhmm, '13:00');
});

test('仮予約: 管理者メールに移動込みのカレンダー追加リンクが入る（第7節）', async () => {
  const date = targetDate();
  const res = await call(reserve, { ...baseApplicant, choice1: toJstIso(jstToEpoch(date, 10 * 60)) });
  const url = res.body.emailParams.admin_calendar_url;

  assert.ok(url.includes('calendar.google.com'), 'カレンダーの予定作成URL');
  assert.ok(url.includes('action=TEMPLATE'), '書き込みAPIではなくテンプレートURL');

  // dates=... が往路出発09:00〜帰着13:00（UTCでは00:00Z〜04:00Z）になっていること
  const dates = decodeURIComponent(new URL(url).searchParams.get('dates'));
  const [from, to] = dates.split('/');
  assert.equal(epochToJst(Date.parse(from.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'))).hhmm, '09:00');
  assert.equal(epochToJst(Date.parse(to.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'))).hhmm, '13:00');
});

test('仮予約: 直前に予定が入っていたら409で選び直しを案内する（受入条件）', async () => {
  const date = targetDate();
  // 10:00開始を狙うが、その時間はすでに埋まっている
  scenario.busy = [{
    start: toJstIso(jstToEpoch(date, 10 * 60)),
    end: toJstIso(jstToEpoch(date, 11 * 60))
  }];
  const res = await call(reserve, { ...baseApplicant, choice1: toJstIso(jstToEpoch(date, 10 * 60)) });

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'slot_taken');
  assert.match(res.body.error, /選び直/);
  assert.equal(scenario.saved, undefined, '保存されていない');
});

test('仮予約: 保存に失敗したら完了にしない（第8節）', async () => {
  scenario.saveFails = true;
  const res = await call(reserve, {
    ...baseApplicant, choice1: toJstIso(jstToEpoch(targetDate(), 10 * 60))
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'storage_unavailable');
  assert.ok(!res.body.referenceCode, '受付番号を出さない');
});

test('仮予約: 境界時刻を弾く（8:00前・20:00超・2時間でない）', async () => {
  const date = targetDate();

  const early = await call(reserve, { ...baseApplicant, choice1: toJstIso(jstToEpoch(date, 7 * 60 + 30)) });
  assert.equal(early.statusCode, 400);
  assert.match(early.body.error, /8:00/);

  const late = await call(reserve, { ...baseApplicant, choice1: toJstIso(jstToEpoch(date, 18 * 60 + 30)) });
  assert.equal(late.statusCode, 400);
  assert.match(late.body.error, /20:00/);

  // 18:00開始（終了ちょうど20:00）は通る
  const ok = await call(reserve, { ...baseApplicant, choice1: toJstIso(jstToEpoch(date, 18 * 60)) });
  assert.equal(ok.statusCode, 200);
});

test('仮予約: 第2希望も同じルールで検証される', async () => {
  const date = targetDate();
  const res = await call(reserve, {
    ...baseApplicant,
    choice1: toJstIso(jstToEpoch(date, 10 * 60)),
    choice2: toJstIso(jstToEpoch(date, 19 * 60)) // 21:00終了 → 不可
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /第2希望/);
});

test('仮予約: 第1希望と第2希望が同じなら弾く', async () => {
  const start = toJstIso(jstToEpoch(targetDate(), 10 * 60));
  const res = await call(reserve, { ...baseApplicant, choice1: start, choice2: start });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /同じ日時/);
});

test('仮予約: 第2希望は1件の申込の代替候補として保存される（2件にしない）', async () => {
  const date = targetDate();
  const res = await call(reserve, {
    ...baseApplicant,
    choice1: toJstIso(jstToEpoch(date, 10 * 60)),
    choice2: toJstIso(jstToEpoch(date, 14 * 60))
  });
  assert.equal(res.statusCode, 200);
  assert.equal(epochToJst(Date.parse(scenario.saved.lesson_start_at)).hhmm, '10:00');
  assert.equal(epochToJst(Date.parse(scenario.saved.alt_lesson_start_at)).hhmm, '14:00');
});

test('仮予約: 二重送信は同じ受付番号を返し、重複保存しない（第8節）', async () => {
  const start = toJstIso(jstToEpoch(targetDate(), 10 * 60));
  scenario.duplicate = { reference_code: 'DT-260101-AAAA', created_at: new Date().toISOString() };

  const res = await call(reserve, { ...baseApplicant, choice1: start });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.duplicate, true);
  assert.equal(res.body.referenceCode, 'DT-260101-AAAA');
  assert.equal(scenario.saved, undefined, '2件目を保存しない');
});

test('仮予約: 規約未同意・不正なメールを弾く', async () => {
  const start = toJstIso(jstToEpoch(targetDate(), 10 * 60));

  const noAgree = await call(reserve, { ...baseApplicant, agree: false, choice1: start });
  assert.equal(noAgree.statusCode, 400);
  assert.match(noAgree.body.error, /規約/);

  const badMail = await call(reserve, { ...baseApplicant, email: 'not-an-email', choice1: start });
  assert.equal(badMail.statusCode, 400);
  assert.match(badMail.body.error, /メールアドレス/);
});

test('連投は429で止める（第8節：連続送信対策）', async () => {
  const start = toJstIso(jstToEpoch(targetDate(), 10 * 60));
  const ip = '10.9.9.9';
  let limited = false;
  for (let i = 0; i < 9; i++) {
    const r = await call(reserve, { ...baseApplicant, choice1: start }, { ip });
    if (r.statusCode === 429) { limited = true; break; }
  }
  assert.ok(limited, '一定回数で429になる');
});

test('顧客への応答に予定の詳細・運賃を含めない（第8節・第6-2節）', async () => {
  const date = targetDate();
  scenario.busy = [{
    start: toJstIso(jstToEpoch(date, 13 * 60)),
    end: toJstIso(jstToEpoch(date, 14 * 60))
  }];
  const res = await call(availability, {
    mode: 'customer', date, courtCoord: '35.630000,139.790000'
  });
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes('fare'), '運賃を返さない');
  assert.ok(!text.includes('480'), '運賃の金額を返さない');
  assert.ok(!text.includes('summary'), 'カレンダーの生データを返さない');
});

// ---------------------------------------------------------------------------
// オンライン動画添削（日程・コート・移動なし。既存メニューを壊していないこと）
// ---------------------------------------------------------------------------

test('オンライン動画添削: 日程なしで申込が通り、料金は既存のまま', async () => {
  const res = await call(reserve, {
    menu: 'online', plan: '5',
    name: '鈴木 花子', email: 'hanako@example.com', phone: '09011112222',
    sns: '@hanako', category: '18歳以上', payment: '銀行振込', agree: true
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.referenceCode, /^DT-\d{6}-[A-Z0-9]{4}$/);
  assert.equal(scenario.saved.menu, 'オンライン動画添削');
  assert.equal(scenario.saved.plan, '5');
  assert.equal(scenario.saved.estimate, 3750, '5回3,750円は既存のまま');
  assert.equal(scenario.saved.lesson_start_at, undefined, '日程は持たない');
});

test('オンライン動画添削: 既存の3プランの金額が変わっていない', async () => {
  for (const [plan, price] of [['3', 2400], ['5', 3750], ['10', 6500]]) {
    const res = await call(reserve, {
      menu: 'online', plan,
      name: 'テスト', email: 't@example.com', phone: '09000000000',
      sns: '@t', category: '18歳以上', payment: '銀行振込', agree: true
    });
    assert.equal(res.statusCode, 200, `plan ${plan}`);
    assert.equal(scenario.saved.estimate, price, `${plan}回は${price}円`);
  }
});

test('オンライン動画添削: プラン未選択は弾く', async () => {
  const res = await call(reserve, {
    menu: 'online',
    name: 'テスト', email: 't@example.com', phone: '09000000000',
    sns: '@t', category: '18歳以上', payment: '銀行振込', agree: true
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /チケットプラン/);
});
