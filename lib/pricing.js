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
    lesson: { solo: 16500, group: null }
  };

  // 新料金（2026-10-17 から）
  var NEW = {
    plans: [
      { key: '3', price: 3300, per: 1100, badge: 'TICKET' },
      { key: '5', price: 4900, per: 980, badge: 'TICKET' },
      { key: '10', price: 8900, per: 890, badge: 'いちばんおトク', best: true }
    ],
    // 1人 16,500円 / 2人以上は人数にかかわらず合計 22,000円
    lesson: { solo: 16500, group: 22000 }
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

  var api = {
    SWITCH_AT: SWITCH_AT,
    OLD: OLD,
    NEW: NEW,
    pricingAt: pricingAt,
    current: function () { return pricingAt(Date.now()); },
    lessonFee: lessonFee,
    perPerson: perPerson,
    perPersonLabel: perPersonLabel
  };
  if (typeof window !== 'undefined') window.DUFFY_PRICING = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
