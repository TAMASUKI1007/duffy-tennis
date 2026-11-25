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
    // サイト上の Stripe 決済を出すかどうか。false のあいだは申込完了画面に支払いボタンを出さず、
    // 従来どおり DM でお支払いを案内する（2026-10-29：PayPay と銀行振込の承認待ちのため一時的に false）。
    // 2026-11-06：PayPay・銀行振込とも Stripe で有効になったため true に戻した。
    enabled: true,

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

    // 対面「3回パッケージ」の支払いリンク（差し込み口）。Stripe で作ったら本番の URL をここに入れる。
    // 空のあいだは packageUrl() が '' を返し、申込は従来の対面の流れ（DM で日程を決めてから支払いリンクを送る）のまま動く。
    // 2026-11-25: 本番リンクを入れた（¥39,800・有効期限なし・氏名収集あり）。申込フォームで「3回パッケージ」を選んで送信すると、
    // オンラインと同じく送信後すぐ、この支払いページへ移動する。
    lessonPackage: 'https://buy.stripe.com/eVq3cv9y57zXbx5boqabK05',
    testLessonPackage: '',

    // イベント（まだなし）。例: { key: 'event-2026-12', label: '12月 ダブルス練習会', url: 'https://buy.stripe.com/...' }
    events: []
  };

  /**
   * 支払いページの URL を作る。メールアドレスを渡すと決済ページに入力済みになる。
   * 申込の照合用に client_reference_id（氏名）も付ける。
   */
  function ticketUrl(planKey, email, name) {
    if (!PAYMENTS.enabled) return '';
    var table = PAYMENTS.mode === 'live' ? PAYMENTS.tickets : PAYMENTS.testTickets;
    var base = table[String(planKey)];
    if (!base || base.indexOf('REPLACE') >= 0) return '';
    var params = [];
    if (email) params.push('prefilled_email=' + encodeURIComponent(email));
    if (name) params.push('client_reference_id=' + encodeURIComponent(String(name).replace(/[^\w\-぀-ヿ一-鿿 ]/g, '').slice(0, 60)));
    return base + (params.length ? '?' + params.join('&') : '');
  }

  /** 3回パッケージの支払いページ URL。リンク未設定なら ''。 */
  function packageUrl(email, name) {
    if (!PAYMENTS.enabled) return '';
    var base = PAYMENTS.mode === 'live' ? PAYMENTS.lessonPackage : PAYMENTS.testLessonPackage;
    if (!base || base.indexOf('REPLACE') >= 0) return '';
    var params = [];
    if (email) params.push('prefilled_email=' + encodeURIComponent(email));
    if (name) params.push('client_reference_id=' + encodeURIComponent(String(name).replace(/[^\w\-぀-ヿ一-鿿 ]/g, '').slice(0, 60)));
    return base + (params.length ? '?' + params.join('&') : '');
  }

  var api = { PAYMENTS: PAYMENTS, ticketUrl: ticketUrl, packageUrl: packageUrl };
  if (typeof window !== 'undefined') window.DUFFY_PAYMENTS = api;
})();
