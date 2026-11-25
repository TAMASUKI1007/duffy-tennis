// 料金の設定。index.html と apply.html の両方がこのファイルを読む。
//
// 2026-10-17 0:00（日本時間）から新料金に切り替わる。
// それまでは旧料金のまま表示・計算する。切り替え後に OLD は消してよい。
//
// 【料金を変えるとき】
//   NEW の数字を書き換えるだけで、トップのMENU・申込フォームの表示・概算・
//   メール本文・保存される金額がすべて変わる。
//   per（1回あたり）は price ÷ 回数 を手で入れる（表示用）。
(function () {
  var SWITCH_AT = Date.parse('2026-10-17T00:00:00+09:00');

  // 旧料金（2026-10-16 まで）
  var OLD = {
    plans: [
      { key: '3', price: 2400, per: 800, badge: 'TICKET' },
      { key: '5', price: 3750, per: 750, badge: 'TICKET' },
      { key: '10', price: 6500, per: 650, badge: 'いちばんおトク', best: true }
    ],
    // group が null なら人数にかかわらず solo の一律料金
    lesson: { solo: 16500, group: null, minutes: 120, package: null }
  };

  // 新料金（2026-10-17 から）
  var NEW = {
    plans: [
      { key: '3', price: 3300, per: 1100, badge: 'TICKET' },
      { key: '5', price: 4900, per: 980, badge: '一番人気', popular: true },
      { key: '10', price: 8900, per: 890, badge: 'いちばんおトク', best: true }
    ],
    // 対面は「1回レッスン（90分）」と「3回パッケージ」の2択（2026-11-25 から）。
    //   solo   = 1回レッスン（1人）の料金。これが「通常価格」の元になる
    //   package = 3回パッケージの回数と合計料金（1人用）。1回あたり・割引率・おトク額は packageInfo() が計算する
    //   group  = 2人以上で1回レッスンの料金。人数にかかわらず一律（2026-11-25 決定：90分で22,000円、従来どおり）
    lesson: { solo: 16500, group: 22000, minutes: 90, package: { count: 3, price: 39800 } }
  };

  function pricingAt(ts) {
    return ts >= SWITCH_AT ? NEW : OLD;
  }

  /** 対面レッスンの合計金額（人数で決まる）。 */
  function lessonFee(p, people) {
    var n = Number(people) || 1;
    return (p.lesson.group && n >= 2) ? p.lesson.group : p.lesson.solo;
  }

  /** 1人あたりの金額。割り切れないときは切り上げ。 */
  function perPerson(p, people) {
    var n = Math.max(1, Number(people) || 1);
    return Math.ceil(lessonFee(p, n) / n);
  }

  /** 「1人11,000円」のような表示。割り切れないときは「約」を付ける。 */
  function perPersonLabel(p, people) {
    var n = Math.max(1, Number(people) || 1);
    var fee = lessonFee(p, n);
    var each = perPerson(p, n);
    return (fee % n === 0 ? '' : '約') + '1人' + each.toLocaleString('ja-JP') + '円';
  }

  /**
   * 3回パッケージの表示用の数字（すべて solo と package から計算。手で書かない）。
   * package が無い料金表では null。
   */
  function packageInfo(p) {
    var pk = p.lesson.package;
    if (!pk) return null;
    var normal = p.lesson.solo * pk.count;
    var save = normal - pk.price;
    return {
      count: pk.count,
      price: pk.price,
      normal: normal,                                  // 通常価格（1回レッスン × 回数）
      save: save,                                      // おトク額
      per: Math.ceil(pk.price / pk.count),             // 1回あたり（切り上げ）
      percent: Math.round(save / normal * 100)         // 割引率（%）
    };
  }

  function yen(n) { return '¥' + Number(n).toLocaleString('ja-JP'); }

  /** 画面・メールで使う文字列。index / apply / guide / terms がここだけを見る。 */
  function packageLabels(p) {
    var i = packageInfo(p);
    if (!i) return null;
    return {
      title: i.count + '回パッケージ',
      price: yen(i.price),
      normal: yen(i.normal),
      save: yen(i.save) + 'おトク',
      per: '1回あたり' + yen(i.per),
      perDiscount: '1回あたり' + yen(i.per) + '（約' + i.percent + '%OFF）',
      was: '通常' + yen(i.normal) + ' → ' + yen(i.price) + '（' + yen(i.save) + 'おトク）',
      single: '1回あたり' + yen(p.lesson.solo)
    };
  }

  var api = {
    SWITCH_AT: SWITCH_AT,
    OLD: OLD,
    NEW: NEW,
    pricingAt: pricingAt,
    current: function () { return pricingAt(Date.now()); },
    lessonFee: lessonFee,
    perPerson: perPerson,
    perPersonLabel: perPersonLabel,
    packageInfo: packageInfo,
    packageLabels: packageLabels
  };
  if (typeof window !== 'undefined') window.DUFFY_PRICING = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
