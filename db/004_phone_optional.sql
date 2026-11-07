-- 電話番号の入力欄を廃止したため、applications.phone が NOT NULL だと保存に失敗する。
-- 列は残したまま、空でも保存できるようにする（既存の行はそのまま）。
-- 実行: Supabase ダッシュボード → SQL Editor に貼って Run。何度実行しても安全。
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'applications' and column_name = 'phone'
  ) then
    alter table public.applications alter column phone drop not null;
  end if;
end $$;
