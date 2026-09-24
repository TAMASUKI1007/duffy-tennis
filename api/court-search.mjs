/**
 * POST /api/court-search
 *
 * コート名から候補住所を返す（要件定義書 第3節A-2・第5-4節）。
 * 同名施設の取り違えを避けるため、お客さんに候補から選んでもらう。
 *
 * 入力: { query: string }
 * 出力: { ok:true, candidates:[{label, address, coord}] }
 */

import { handler, readJson, sendJson, throttle, PublicError } from './_lib/http.mjs';
import { findPlaces } from './_lib/geocode.mjs';

export default handler(async (req, res) => {
  throttle(req, { limit: 30, windowMs: 60000, key: 'court-search' });

  const body = await readJson(req);
  const query = typeof body.query === 'string' ? body.query.trim() : '';

  if (query.length < 2) throw new PublicError('コート名を2文字以上で入力してください。');
  if (query.length > 100) throw new PublicError('コート名が長すぎます。');

  const candidates = await findPlaces(query);

  return sendJson(res, 200, {
    ok: true,
    candidates: candidates.map((c) => ({ label: c.label, address: c.address, coord: c.coord })),
    notice: candidates.length === 0
      ? '該当する場所が見つかりませんでした。施設名や住所を変えてお試しください。'
      : null
  });
});
