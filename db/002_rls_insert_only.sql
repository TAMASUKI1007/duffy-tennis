-- ============================================================================
-- applications テーブルのRLS設定：匿名は「追加のみ可」
--
-- ⚠️ まだ実行していません。内容をご確認のうえ、Supabase の SQL Editor で
--    実行してください（本番テーブルの設定変更のため）。
--
-- 【なぜ必要か】
--   2026-09-25 に確認したところ、匿名キーでの INSERT が RLS に拒否されていました。
--       {"code":"42501","message":"new row violates row-level security policy
--        for table \"applications\""}
--   申込フォームはブラウザから公開キーで直接 INSERT するため、この状態では
--   申込が1件も保存されません。追加だけを許可するポリシーが必要です。
--
-- 【この SQL で実現する状態】
--   匿名（anon）… 追加(INSERT)のみ可。読み取り・更新・削除は不可
--   ログイン済み一般ユーザー(authenticated) … 何もできない
--   service_role（管理用） … RLSを迂回するので従来どおり全部できる
-- ============================================================================

-- 1. RLS を有効にする（すでに有効なら変化なし）
alter table public.applications enable row level security;

-- 2. テーブル権限。INSERT だけを anon に与える。
--    （RLS のポリシーとは別に、テーブルの GRANT も必要）
revoke all on public.applications from anon;
revoke all on public.applications from authenticated;
grant insert on public.applications to anon;

-- 3. 追加を許可するポリシー。
--    SELECT / UPDATE / DELETE のポリシーは作らない。
--    RLS 有効下でポリシーが無いコマンドは、すべて拒否される。
drop policy if exists "anon_insert_applications" on public.applications;
create policy "anon_insert_applications"
  on public.applications
  for insert
  to anon
  with check (true);


-- ============================================================================
-- 実行後の確認
-- ============================================================================

-- (a) RLS が有効か  → relrowsecurity = true になっていること
-- select relname, relrowsecurity from pg_class where relname = 'applications';

-- (b) ポリシーが INSERT の1本だけか
-- select polname, cmd, roles from pg_policies where tablename = 'applications';
--     → anon_insert_applications / INSERT / {anon} の1件だけ

-- (c) anon の権限が INSERT だけか
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_name = 'applications' and grantee = 'anon';
--     → INSERT の1件だけ


-- ============================================================================
-- 動作確認（テスト用データのみ）
--
--   1. 追加できること
--      curl -X POST "$URL/rest/v1/applications" \
--        -H "apikey: <公開キー>" -H "Authorization: Bearer <公開キー>" \
--        -H "Content-Type: application/json" \
--        -d '{"name":"RLSテスト","email":"rls@example.invalid","phone":"000"}'
--      → 201 が返ること
--
--   2. 読み取れないこと
--      curl "$URL/rest/v1/applications?select=id&limit=1" -H "apikey: <公開キー>"
--      → [] が返ること（テストで入れた行も見えない）
--
--   3. 更新・削除できないこと
--      curl -X PATCH "$URL/rest/v1/applications?name=eq.RLSテスト" ... -d '{"name":"x"}'
--      curl -X DELETE "$URL/rest/v1/applications?name=eq.RLSテスト" ...
--      → いずれも行が変わらないこと（管理画面で確認）
--
--   4. 確認が終わったら、Supabase の管理画面からテスト行を削除する
--      delete from public.applications where email = 'rls@example.invalid';
-- ============================================================================
