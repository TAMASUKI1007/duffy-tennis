/**
 * 経路API検証スクリプト（要件定義書 第5-1節 / 受入条件「東小金井駅発着の公共交通経路が
 * 時刻指定で取得できることを検証結果として示す」）
 *
 * 何を確かめるか:
 *   1. 東小金井駅 ⇄ 関東の代表的なコートの往復が、公共交通（電車・バス・徒歩）で取得できるか
 *   2. 往路の「到着時刻指定」(goal_time) が効くか  ← レッスン開始Sまでに着く経路が必要
 *   3. 復路の「出発時刻指定」(start_time) が効くか ← レッスン終了E以降に出る経路が必要
 *   4. 平日／土曜／日曜、朝／夕で所要時間が変わるか（＝ダイヤを見ているか）
 *   5. 往路と復路の所要時間が非対称になりうるか（第4節「往復で同じ所要時間とは仮定しない」）
 *
 * 使い方:
 *   1. RapidAPI で NAVITIME Route (totalnavi) を購読し、キーを取得する
 *   2. .env.example を .env にコピーして RAPIDAPI_KEY を記入する（.env は .gitignore 済み）
 *   3. node scripts/verify-route-api.mjs
 *
 * 安全装置:
 *   - MAX_CALLS を超えたら必ず停止する（無料枠 500 アクセスを溶かさないため）
 *   - 取得できなかった経路を「空き」や「移動0分」として扱わない。必ず FAIL として表示する
 *   - 生の応答は scripts/out/ に保存する（.gitignore 済み）
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT_DIR = join(HERE, 'out');

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

/** 1回の実行で許す最大API呼び出し数。無料枠を使い切らないための安全装置。 */
const MAX_CALLS = 40;

/** 出発・帰着地点。要件定義書 第2節で東小金井駅に固定。 */
const HOME = {
  name: '東小金井駅',
  // 概算座標。実行結果の経路が東小金井駅始発になっているかログで必ず確認すること。
  coord: '35.701700,139.524400'
};

/**
 * 検証対象コート。座標は概算のため、応答に含まれる地点名で妥当性を確認すること。
 * 近距離・中距離・遠距離を1件ずつ選び、関東の広がりを代表させている。
 */
const COURTS = [
  { id: 'mitaka',  name: '三鷹市大沢総合グラウンド周辺（運営者手配の想定圏）', coord: '35.677000,139.535000' },
  { id: 'showa',   name: '国営昭和記念公園周辺（立川・中距離）',               coord: '35.705000,139.403000' },
  { id: 'ariake',  name: '有明テニスの森公園周辺（都心東部・遠距離）',          coord: '35.630000,139.790000' }
];

/**
 * 検証する日付。平日・土曜・日曜を1日ずつ。
 * 「2日後〜30日先」（確認リスト#1）の範囲に収まる直近の各曜日を自動で選ぶ。
 */
function pickDates(base = new Date()) {
  const at = (n) => {
    const d = new Date(base);
    d.setDate(d.getDate() + n);
    d.setHours(0, 0, 0, 0);
    return d;
  };
  const found = {};
  for (let n = 2; n <= 30; n++) {
    const d = at(n);
    const dow = d.getDay();
    const label = dow === 0 ? '日曜' : dow === 6 ? '土曜' : '平日';
    if (!found[label]) found[label] = { date: d, label };
    if (found['平日'] && found['土曜'] && found['日曜']) break;
  }
  return Object.values(found);
}

/** レッスン開始時刻S。朝（最早）と夕（最遅）。第2節より S は 08:00〜18:00。 */
const START_HOURS = [
  { label: '朝', h: 8 },
  { label: '夕', h: 18 }
];

const LESSON_MINUTES = 120;

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

function loadEnv() {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/** NAVITIME が要求する ISO 形式 YYYY-MM-DDThh:mm:ss（ローカル時刻、Asia/Tokyo 前提）。 */
function iso(date, hours, minutes = 0) {
  const d = new Date(date);
  d.setHours(hours, minutes, 0, 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

function addMinutes(date, hours, minutes) {
  const d = new Date(date);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

let callCount = 0;
const rawLog = [];

async function routeTransit({ start, goal, startTime, goalTime, tag }) {
  if (callCount >= MAX_CALLS) {
    throw new Error(`API呼び出し上限 ${MAX_CALLS} 件に達したため停止しました。`);
  }
  callCount++;

  const params = new URLSearchParams({ start, goal, datum: 'wgs84', term: '1440', limit: '3' });
  if (goalTime) params.set('goal_time', goalTime);
  else params.set('start_time', startTime);
  // 車・飛行機・フェリーは対象外（第2節：徒歩・自転車・電車・バスのみ）
  params.set('unuse', 'domestic_flight.ferry');

  const host = process.env.RAPIDAPI_HOST || 'navitime-route-totalnavi.p.rapidapi.com';
  const url = `https://${host}/route_transit?${params}`;

  const res = await fetch(url, {
    headers: {
      'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
      'X-RapidAPI-Host': host
    }
  });

  const text = await res.text();
  rawLog.push({ tag, status: res.status, url: url.replace(/(\?|&)/g, '\n  $1'), body: text.slice(0, 20000) });

  if (!res.ok) {
    return { ok: false, reason: `HTTP ${res.status}`, detail: text.slice(0, 300) };
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'JSONとして解釈できない応答' };
  }

  const items = json.items || [];
  if (!items.length) return { ok: false, reason: '経路0件（この時刻に成立する公共交通経路なし）' };

  // 所要時間が最小の経路を採用する
  const best = items.reduce((a, b) =>
    (a?.summary?.move?.time ?? Infinity) <= (b?.summary?.move?.time ?? Infinity) ? a : b);

  const move = best?.summary?.move || {};
  const modes = [...new Set((best.sections || [])
    .filter((s) => s.type === 'move')
    .map((s) => s.move))];

  return {
    ok: true,
    minutes: move.time,
    fare: move.fare?.unit_0 ?? null,
    transitCount: move.transit_count ?? null,
    modes,
    from: best.sections?.[0]?.name,
    to: best.sections?.[best.sections.length - 1]?.name
  };
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

async function main() {
  loadEnv();

  if (!process.env.RAPIDAPI_KEY) {
    console.error('RAPIDAPI_KEY が未設定です。.env.example を .env にコピーしてキーを記入してください。');
    console.error('（キーはこのファイルにも、チャットにも書かないでください）');
    process.exit(1);
  }

  const dates = pickDates();
  const rows = [];

  console.log(`検証開始: ${HOME.name} ⇄ コート ${COURTS.length}件 × ${dates.length}日 × ${START_HOURS.length}時間帯`);
  console.log(`上限 ${MAX_CALLS} 呼び出し\n`);

  outer:
  for (const court of COURTS) {
    for (const { date, label } of dates) {
      for (const { label: hLabel, h } of START_HOURS) {
        const S = addMinutes(date, h, 0);
        const E = addMinutes(date, h + LESSON_MINUTES / 60, 0);
        const tag = `${court.id}/${label}/${hLabel}`;

        try {
          // 往路: レッスン開始Sまでに到着する必要がある → goal_time
          const out = await routeTransit({
            start: HOME.coord, goal: court.coord,
            goalTime: iso(S, S.getHours(), S.getMinutes()), tag: tag + '/往路'
          });

          // 復路: レッスン終了E以降に出発する → start_time
          const back = await routeTransit({
            start: court.coord, goal: HOME.coord,
            startTime: iso(E, E.getHours(), E.getMinutes()), tag: tag + '/復路'
          });

          rows.push({ court: court.name, date: iso(date, 0).slice(0, 10), dow: label, slot: hLabel, S: `${h}:00`, out, back });
        } catch (e) {
          console.error(`\n停止: ${e.message}`);
          break outer;
        }
      }
    }
  }

  // --- 結果表示 ---
  console.log('\n===== 検証結果 =====\n');
  for (const r of rows) {
    const fmt = (x) => x.ok
      ? `${String(x.minutes).padStart(3)}分 (${x.modes.join('+') || '不明'}, 乗換${x.transitCount ?? '?'}回, ${x.fare != null ? x.fare + '円' : '運賃不明'})`
      : `FAIL: ${x.reason}`;
    console.log(`${r.date}(${r.dow}) ${r.slot} S=${r.S}  ${r.court}`);
    console.log(`   往路 ${fmt(r.out)}`);
    console.log(`   復路 ${fmt(r.back)}`);
    if (r.out.ok && r.back.ok && r.out.minutes !== r.back.minutes) {
      console.log(`   → 往復で所要時間が非対称（差 ${Math.abs(r.out.minutes - r.back.minutes)}分）`);
    }
    console.log('');
  }

  // --- 判定 ---
  const okRows = rows.filter((r) => r.out.ok && r.back.ok);
  const transitUsed = okRows.some((r) => r.out.modes.some((m) => /train|bus/i.test(m)));
  const timeVaries = new Set(okRows.map((r) => `${r.court}|${r.out.minutes}`)).size > new Set(okRows.map((r) => r.court)).size;

  console.log('===== 判定 =====');
  console.log(`API呼び出し数         : ${callCount} / 上限 ${MAX_CALLS}`);
  console.log(`往復とも取得できた組数: ${okRows.length} / ${rows.length}`);
  console.log(`電車・バスの区間を含む: ${transitUsed ? 'YES' : 'NO ← 公共交通が返っていない'}`);
  console.log(`時刻で所要時間が変動  : ${timeVaries ? 'YES（ダイヤを参照している）' : 'NO ← 固定値の疑い。要確認'}`);
  console.log(`\n総合: ${okRows.length === rows.length && transitUsed ? '採用可' : '要検討（駅すぱあととの比較へ）'}`);

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(OUT_DIR, `route-verify-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify({ rows, rawLog, callCount }, null, 2), 'utf8');
  console.log(`\n生の応答: ${outPath}`);
}

main().catch((e) => {
  console.error('検証スクリプトが異常終了しました:', e);
  process.exit(1);
});
