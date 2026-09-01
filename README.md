# WPtoSSG

WordPressサイトを静的サイト（SSG）としてエクスポートするためのツールです。  
URLを起点にクロールし、ページをHTMLとして固定化し、内部アセットを収集して出力します。

---

## 概要

WPtoSSG は、公開中の WordPress サイトを対象に、以下を自動化します。

- サイト全体をクロールして **URLグラフ（サイトマップGraph）** を生成
- Playwright でレンダリング後の DOM を取得して **静的HTML化**
- 画像/CSS/JavaScript/フォントなどの **内部アセット取得**
- 既知ライブラリの **CDN URL への置換**
- 変換結果を Google Drive に `current` と `archive` 運用で保存
- 変換完了後に「静的化できない可能性」の診断結果を出力

> 想定対象: 公開ページのみ（ログイン不要サイト）、100ページ未満

---

## システム構成

- Frontend: **Next.js 15 (App Router) + Tailwind + shadcn/ui**（Vercel）
- Backend Worker: **Node.js + TypeScript + Playwright + Cheerio**（Railway）
- Queue: **BullMQ + Redis**（Railway）
- Database: **PostgreSQL (Supabase)**
- Storage: **Google Drive**
- Realtime 通知: **Server-Sent Events (SSE)**

---

## 主な機能

1. クロール＆Graph生成
   - URL一覧ではなく、ページ/アセット/API/フォームをノードとして保持
   - ノード間の関係（links_to, loads_asset, calls_api, has_form 等）をエッジとして保持

2. HTML静的化
   - Playwright で JS 実行後の HTML を保存
   - 無限スクロール・lazy load へ対応

3. アセット処理
   - 同一ドメインの素材は取得してローカル参照化
   - 外部ドメインへのリンク/参照は原則維持

4. CDN変換
   - 既知ライブラリのみマッピングテーブルに基づいて CDN 化

5. 診断
   - 同ドメインAPI呼び出し
   - フォーム存在
   - ログイン要求の兆候
   をもとに静的化リスクを算出

6. Drive保存運用
   - `/sites/{siteKey}/current`
   - 再実行時に `current` を `/archive/{timestamp}` へ退避

---

## 想定ディレクトリ構成

```txt
.
├─ apps/
│  ├─ web/                  # Next.js (UI + API + SSE)
│  └─ worker/               # BullMQ Worker (Playwright)
├─ packages/
│  ├─ shared/               # 型定義・スキーマ
│  └─ config/               # CDNマップ等
├─ infra/
│  ├─ supabase/             # SQL/DDL
│  └─ railway/              # デプロイ補助
└─ docs/
```

---

## ジョブステージ（BullMQ）

1. `PRECHECK`
2. `CRAWL_GRAPH`
3. `RENDER_AND_SNAPSHOT`
4. `ASSET_FETCH_AND_REWRITE`
5. `DIAGNOSTIC`
6. `ROTATE_AND_UPLOAD`
7. `FINALIZE`

各ステージの進捗は `job_events` に記録され、SSEでフロントへ配信されます。

---

## SSEイベント例

- `job_state_changed`
- `stage_progress`
- `page_done`
- `warning`
- `diagnostic_ready`
- `completed`
- `failed`

---

## セットアップ（予定）

> 初期実装中。詳細な手順は今後更新します。

必要サービス:

- Vercel（web）
- Railway（worker + redis）
- Supabase（postgres）
- Google Cloud（Drive API サービスアカウント）

主な環境変数（例）:

- `DATABASE_URL`
- `REDIS_URL`
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `GOOGLE_DRIVE_ROOT_FOLDER_ID`
- `NEXT_PUBLIC_APP_URL`

---

## 非対象（現時点）

- ログイン必須ページの取得
- フォーム送信後状態の再現
- 完全な動的アプリの振る舞い再現

---

## ライセンス

TBD
