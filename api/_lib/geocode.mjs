/**
 * 施設名から住所・座標を得る（要件定義書 第5-4節・第3節A-2）。
 *
 * Google Geocoding API を使う。日本はジオコーディング対応地域（公式カバレッジ表）。
 * 同名施設の取り違えを避けるため、候補を複数返してお客さんに選んでもらう。
 *
 * APIキーはサーバー側だけで保持する。ブラウザには座標と表示用住所しか返さない。
 */

export class GeocodeError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'GeocodeError';
    this.cause = cause;
  }
}

/** 関東の緩い外接矩形。ここから外れた候補は落とす（第2節「対応地域：関東」）。 */
const KANTO_BOUNDS = { minLat: 34.9, maxLat: 37.2, minLng: 138.4, maxLng: 140.9 };

export function isInKanto(lat, lng) {
  return lat >= KANTO_BOUNDS.minLat && lat <= KANTO_BOUNDS.maxLat
    && lng >= KANTO_BOUNDS.minLng && lng <= KANTO_BOUNDS.maxLng;
}

/**
 * 施設名・住所から候補地点を返す。
 * @returns {Promise<Array<{label:string, address:string, coord:string, lat:number, lng:number}>>}
 */
export async function findPlaces(query, env = process.env) {
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new GeocodeError('場所検索のキーが設定されていません。');

  const params = new URLSearchParams({
    address: query,
    key,
    language: 'ja',
    region: 'jp',
    // 関東に寄せる
    bounds: `${KANTO_BOUNDS.minLat},${KANTO_BOUNDS.minLng}|${KANTO_BOUNDS.maxLat},${KANTO_BOUNDS.maxLng}`
  });

  let res;
  try {
    res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
  } catch (e) {
    throw new GeocodeError('場所検索サービスに接続できませんでした。', e);
  }
  if (!res.ok) throw new GeocodeError(`場所検索サービスがエラーを返しました (HTTP ${res.status})`);

  const json = await res.json();

  if (json.status === 'ZERO_RESULTS') return [];
  if (json.status !== 'OK') {
    throw new GeocodeError(`場所検索に失敗しました (${json.status})`);
  }

  return (json.results || [])
    .map((r) => {
      const lat = r.geometry?.location?.lat;
      const lng = r.geometry?.location?.lng;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return {
        label: r.formatted_address,
        address: r.formatted_address,
        coord: `${lat.toFixed(6)},${lng.toFixed(6)}`,
        lat,
        lng,
        inKanto: isInKanto(lat, lng)
      };
    })
    .filter(Boolean)
    .filter((r) => r.inKanto)
    .slice(0, 5);
}

/** ブラウザから送られてきた座標文字列を検証する（第8節：サーバー側検証）。 */
export function parseCoord(value) {
  if (typeof value !== 'string') return null;
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!isInKanto(lat, lng)) return null;
  return `${lat},${lng}`;
}
