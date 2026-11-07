// オンライン動画添削の「今月の受付枠」。運用者が下の数字を書き換えるだけで反映される。
//
//   capacity … 今月の受付上限（名）
//   accepted … 今月すでに受け付けた人数（名）。自動では数えない。申込が入るたびに +1 する
//   month    … この数字が有効な月（'YYYY-MM'・日本時間）。月が変わると表示は自動で消える
//
// 【毎月の更新】月初に month を新しい月にし、accepted を 0 に戻して `npm run deploy`。
// 残り（capacity - accepted）が 0 になると、申込フォームはウェイティングリスト登録に切り替わり、
// 決済ボタンは出なくなる。対面レッスンは受付数を管理しない。
(function () {
  var AVAILABILITY = {
    online: { capacity: 10, accepted: 0, month: '2026-11' }
  };

  /** 日本時間の年月 'YYYY-MM' */
  function jstMonth(ts) {
    var d = new Date((ts == null ? Date.now() : ts) + 9 * 3600 * 1000);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  }

  /**
   * メニューごとの受付状況。設定がない・月が違うときは active:false（何も表示せず、満席にもしない）。
   */
  function status(key, ts) {
    var c = AVAILABILITY[key];
    if (!c) return { active: false, full: false, remaining: null, capacity: null, accepted: null };
    var active = c.month === jstMonth(ts);
    var remaining = Math.max(0, c.capacity - c.accepted);
    return { active: active, full: active && remaining === 0, remaining: remaining, capacity: c.capacity, accepted: c.accepted, month: c.month };
  }

  var api = { AVAILABILITY: AVAILABILITY, status: status, jstMonth: jstMonth };
  if (typeof window !== 'undefined') window.DUFFY_AVAILABILITY = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
