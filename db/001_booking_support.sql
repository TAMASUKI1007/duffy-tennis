-- ============================================================================
-- 予約支援機能のためのテーブル変更とRLS設定
--
-- ⚠️ このSQLはまだ実行していません。運営者が内容を確認してから
--    Supabaseの SQL Editor で実行してください（本番テーブルの構造変更のため）。
--
-- 方針:
--   - 既存の申込データを壊さない。列の追加のみで、削除・型変更はしない
--   - 追加する列はすべて NULL 許容。既存行はそのまま残る
--   - ブラウザからの直接書き込みは廃止したので、anon（公開キー）の権限は落とす
--   - サーバー（/api）は service_role キーを使い、RLSを迂回して読み書きする
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 列の追加
-- ----------------------------------------------------------------------------

alter table public.applications
  -- 受付番号。お客さんがLINEで伝える識別子
  add column if not exists reference_code text,
  -- 相談待ち / 確定 / 取消
  add column if not exists status text default 'pending',

  -- コート手配の担当: 'operator'（運営者・三鷹周辺） / 'customer'（お客さん指定）
  add column if not exists court_arranger text,
  add column if not exists court_address text,
  add column if not exists court_coord text,

  -- レッスン本体（第1希望）
  add column if not exists lesson_start_at timestamptz,
  add column if not exists lesson_end_at timestamptz,
  -- 往路出発D〜帰着A。手動でカレンダーに登録する区間であり、
  -- 相談待ちの間は他の申込の空き判定でも塞ぐ対象になる
  add column if not exists depart_at timestamptz,
  add column if not exists arrive_back_at timestamptz,
  add column if not exists outbound_minutes integer,
  add column if not exists inbound_minutes integer,

  -- 第2希望（1件の申込の代替候補。2件の予約ではない）
  add column if not exists alt_lesson_start_at timestamptz,
  add column if not exists alt_lesson_end_at timestamptz,
  add column if not exists alt_depart_at timestamptz,
  add column if not exists alt_arrive_back_at timestamptz,

  -- メール通知の結果。保存は成功したがメールだけ失敗したケースに気づくため
  add column if not exists notify_status text,
  add column if not exists notify_error text;

-- 受付番号は重複しない
create unique index if not exists applications_reference_code_key
  on public.applications (reference_code)
  where reference_code is not null;

-- 空き判定は「相談待ちで、指定期間に重なるもの」を引くので、その形に合わせる
create index if not exists applications_pending_window_idx
  on public.applications (status, depart_at, arrive_back_at)
  where status = 'pending';

-- 二重送信の判定（同じメール・同じ開始時刻）
create index if not exists applications_dedupe_idx
  on public.applications (email, lesson_start_at);

comment on column public.applications.depart_at is
  '往路出発時刻。カレンダーにはここから arrive_back_at までを1予定として手動登録する';
comment on column public.applications.status is
  'pending=相談待ち（空き判定で枠を塞ぐ） / confirmed=確定 / cancelled=取消';


-- ----------------------------------------------------------------------------
-- 2. RLS（行レベルセキュリティ）
--
-- 改修前はブラウザから公開キーで直接 INSERT していたが、これをやめて
-- /api/reserve 経由に一本化した。したがって anon / authenticated に
-- 権限は一切不要になる。
--
-- service_role キーは RLS を迂回するため、サーバー側の読み書きは影響を受けない。
-- ----------------------------------------------------------------------------

alter table public.applications enable row level security;

-- 既存のポリシーがあれば落とす（名前は環境により異なるので、確認してから調整すること）
-- select polname from pg_policies where tablename = 'applications';
drop policy if exists "anon insert" on public.applications;
drop policy if exists "Enable insert for anon" on public.applications;
drop policy if exists "public insert" on public.applications;

-- ポリシーを1つも作らない = RLS有効下では anon / authenticated は
-- SELECT も INSERT も UPDATE も DELETE もできない。
-- （念のため権限自体も落とす）
revoke all on public.applications from anon;
revoke all on public.applications from authenticated;


-- ----------------------------------------------------------------------------
-- 3. 実行後の確認（この3つの結果を控えておくこと）
-- ----------------------------------------------------------------------------

-- (a) RLSが有効か
-- select relname, relrowsecurity from pg_class where relname = 'applications';
--     → relrowsecurity = true であること

-- (b) ポリシーが残っていないか
-- select polname, roles, cmd from pg_policies where tablename = 'applications';
--     → 0件であること

-- (c) anon の権限が無いこと
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_name = 'applications' and grantee in ('anon','authenticated');
--     → 0件であること


-- ----------------------------------------------------------------------------
-- 4. 動作確認の手順（テストデータのみを使うこと）
--
--   1. 公開キー（anon）で SELECT を試し、0件またはエラーになることを確認する
--      curl "$SUPABASE_URL/rest/v1/applications?select=id&limit=1" \
--           -H "apikey: <公開キー>"
--      → 既存の申込が読めてしまう場合は、上の revoke / policy を見直す
--
--   2. /api/reserve からテスト用の申込を1件入れ、列が正しく埋まるか確認する
--
--   3. 確認が済んだらテストデータを削除する
--      delete from public.applications where reference_code like 'DT-%' and email = '<テスト用アドレス>';
-- ----------------------------------------------------------------------------
