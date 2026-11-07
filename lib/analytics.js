// Cloudflare Web Analytics（アクセス解析）。index / apply / guide から読み込む。
//
// 【有効にするとき】Cloudflare ダッシュボード → Analytics & Logs → Web Analytics → サイトを追加
// （duffy-tennis.pages.dev）で出るトークンを、下の CF_ANALYTICS_TOKEN に貼って `npm run deploy`。
// 空のあいだは何も読み込まない。
//
// 個人を特定する情報は送らない：Cloudflare のビーコンは Cookie を使わず、IP も保存しない。
// この読み込みコードは氏名・メール・申込内容を一切渡さない（トークンだけを渡す）。
(function () {
  var CF_ANALYTICS_TOKEN = '';

  if (!CF_ANALYTICS_TOKEN || typeof document === 'undefined') return;
  var s = document.createElement('script');
  s.defer = true;
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  s.setAttribute('data-cf-beacon', JSON.stringify({ token: CF_ANALYTICS_TOKEN }));
  document.head.appendChild(s);
})();
