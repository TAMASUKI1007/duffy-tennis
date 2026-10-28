// オンライン動画添削のお支払い（Stripe の支払いリンク）。
//
// 申込フォームでオンラインを選んで送信すると、完了画面に「Stripeで支払う」ボタンが出る。
// ボタンの先は Stripe が用意した決済ページ（buy.stripe.com）。サーバーは不要。
//
// 【本番に切り替えるとき】
//   Stripe の本番環境で同じ商品の支払いリンクを作り、下の URL を buy.stripe.com/xxxx
//   （test_ が付かないもの）に差し替える。mode を 'live' にする。
//
// 【イベントの支払いを足すとき】
//   Stripe でイベント用の支払いリンクを作り、events に 1 行足す。
//   サイトや DM にそのまま貼れる。
(function () {
  var PAYMENTS = {
    // 'live' = 本番（2026-10-29 切り替え）。'test' にするとテスト用リンクに差し替えて確認できる
    mode: 'live',

    // チケット回数 → 支払いリンク
    tickets: {
      '3': 'https://buy.stripe.com/cNibJ111z07v0Sr646abK02',
      '5': 'https://buy.stripe.com/00w28raC98E1at1akmabK01',
      '10': 'https://buy.stripe.com/bJefZhbGd9I58kTgIKabK00'
    },

    // テスト用（サンドボックス）。mode を 'test' にしたときはこちらを使う
    testTickets: {
      '3': 'https://buy.stripe.com/test_14AbJ3cwFa3n1uM7uEaAw02',
      '5': 'https://buy.stripe.com/test_9B6aEZ4098Zjc9q02caAw01',
      '10': 'https://buy.stripe.com/test_28EdRbdAJejD2yQ7uEaAw00'
    },

    // イベント（まだなし）。例: { key: 'event-2026-12', label: '12月 ダブルス練習会', url: 'https://buy.stripe.com/...' }
    events: []
  };

  /**
   * 支払いページの URL を作る。メールアドレスを渡すと決済ページに入力済みになる。
   * 申込の照合用に client_reference_id（氏名）も付ける。
   */
  function ticketUrl(planKey, email, name) {
    var table = PAYMENTS.mode === 'live' ? PAYMENTS.tickets : PAYMENTS.testTickets;
    var base = table[String(planKey)];
    if (!base || base.indexOf('REPLACE') >= 0) return '';
    var params = [];
    if (email) params.push('prefilled_email=' + encodeURIComponent(email));
    if (name) params.push('client_reference_id=' + encodeURIComponent(String(name).replace(/[^\w\-぀-ヿ一-鿿 ]/g, '').slice(0, 60)));
    return base + (params.length ? '?' + params.join('&') : '');
  }

  var api = { PAYMENTS: PAYMENTS, ticketUrl: ticketUrl };
  if (typeof window !== 'undefined') window.DUFFY_PAYMENTS = api;
})();
