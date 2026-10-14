-- ============================================================================
-- applications テーブルに「年齢」と「知ったきっかけ」の列を追加
--
-- 実行場所：Supabase 管理画面 → SQL Editor
--
-- 【背景】
--   申込フォームの「区分」（12歳未満 / 12〜15歳 …）を廃止し、年齢を数字で
--   入力する形にした。あわせて「どこで知ったか」（Instagram / TikTok /
--   Facebook / YouTube / 知人の紹介 / その他）を選んでもらうようにした。
--
-- 【この SQL を実行しないとどうなるか】
--   フォームは age / source 列への保存に失敗すると、自動的にその2項目を
--   question（質問・ご要望）列の先頭に書き足して保存し直す。申込は失われない
--   が、列として集計できないので、早めに実行すること。
--
-- 【互換】
--   category 列には引き続き「25歳」のような文字列が入る（既存の一覧用）。
-- ============================================================================

alter table public.applications
  add column if not exists age    integer,
  add column if not exists source text;

comment on column public.applications.age    is '受講者の年齢（数値）';
comment on column public.applications.source is '知ったきっかけ：Instagram / TikTok / Facebook / YouTube / 知人の紹介 / その他';

-- 確認：2列が増えていること
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'applications'
   and column_name in ('age', 'source');
