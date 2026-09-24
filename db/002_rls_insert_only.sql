-- ============================================================================
-- applications テーブルのRLS設定：匿名は「追加のみ可」
--
-- 実行場所：Supabase 管理画面 → SQL Editor
--
-- 【なぜ必要か】
--   2026-09-25 に確認したところ、匿名キーでの INSERT が RLS に拒否されていました。
--       {"code":"42501","message":"new row violates row-level security policy
--        for table \"applications\""}
--   申込フォームはブラウザから公開キーで直接 INSERT するため、この状態では
--   申込が1件も保存されません。追加だけを許可するポリシーが必要です。
--
-- 【この SQL で実現する状態】
--   匿名(anon) ............ 追加(INSERT)のみ可。読み取り・更新・削除は不可
--   ログイン済み(authenticated) ... 何もできない
--   service_role（管理用） ... RLSを迂回するので従来どおり全部できる
--
-- 【id の型について】
--   id が serial / bigserial の場合、INSERT 時にシーケンスを使うため
--   anon にシーケンスの USAGE 権限が必要です。
--   id が identity 列（GENERATED ... AS IDENTITY）や uuid の場合は不要です。
--   外部からは型を判別できなかったため、下の手順4で自動的に判定し、
--   必要なときだけ権限を付けます。どちらの型でも安全に実行できます。
-- ============================================================================


-- 1. RLS を有効にする（すでに有効なら変化なし）
alter table public.applications enable row level security;


-- 2. テーブル権限をいったん落として、INSERT だけを anon に与える
revoke all on public.applications from anon;
revoke all on public.applications from authenticated;
grant insert on public.applications to anon;


-- 3. 追加を許可するポリシー
--    SELECT / UPDATE / DELETE のポリシーは作らない。
--    RLS 有効下でポリシーが無いコマンドは、すべて拒否される。
drop policy if exists "anon_insert_applications" on public.applications;
create policy "anon_insert_applications"
  on public.applications
  for insert
  to anon
  with check (true);


-- 4. id が serial / bigserial のときだけ、シーケンスの権限を付ける
--    （identity 列や uuid のときは何もしない）
do $$
declare
  seq_name text;
  ident    char;
begin
  seq_name := pg_get_serial_sequence('public.applications', 'id');

  if seq_name is null then
    raise notice 'id にシーケンスはありません（uuid 等）。シーケンス権限は不要です。';
    return;
  end if;

  select a.attidentity into ident
    from pg_attribute a
   where a.attrelid = 'public.applications'::regclass
     and a.attname  = 'id';

  if ident = '' then
    -- attidentity が空 = identity 列ではない = serial / bigserial
    execute format('grant usage, select on sequence %s to anon', seq_name);
    raise notice 'serial 列のため、シーケンス % に USAGE/SELECT を付与しました。', seq_name;
  else
    raise notice 'id は identity 列（attidentity=%）のため、シーケンス権限は不要です。', ident;
  end if;
end $$;


-- ============================================================================
-- 実行後の確認（この4つを順に実行して結果を控えてください）
-- ============================================================================

-- (a) RLS が有効か → relrowsecurity が true
select relname, relrowsecurity
  from pg_class
 where relname = 'applications';

-- (b) ポリシーが INSERT の1本だけか
--     → anon_insert_applications / INSERT / {anon} の1件だけ
select polname, cmd, roles
  from pg_policies
 where tablename = 'applications';

-- (c) anon の権限が INSERT だけか
select grantee, privilege_type
  from information_schema.role_table_grants
 where table_name = 'applications'
   and grantee in ('anon', 'authenticated');

-- (d) id の型と、シーケンス権限の状況
select a.attname,
       format_type(a.atttypid, a.atttypmod) as type,
       case a.attidentity when '' then 'serial または通常列' else 'identity 列' end as id_kind,
       pg_get_serial_sequence('public.applications', 'id')                      as sequence
  from pg_attribute a
 where a.attrelid = 'public.applications'::regclass
   and a.attname  = 'id';
