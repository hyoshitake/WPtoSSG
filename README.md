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

詳細な対象範囲・非対象範囲・責務境界は `docs/requirements-and-boundaries.md` を参照してください。

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

## モジュール分割案

WPtoSSG は責務ごとに 4 層に分割し、重い処理を Worker に閉じ込める構成を採用する。

### 1. apps/web

- 役割
  - Next.js 15 App Router ベースの UI
  - ジョブ作成 API
  - 状態確認 API
  - SSE 測定用のイベント配信
  - 変換結果の表示・診断結果の可視化
- 目的
  - ユーザーがサイト URL を入力し、ジョブを起動し、進捗と結果を確認できるようにする

### 2. apps/worker

- 役割
  - BullMQ ジョブ実行
  - クロール、Graph 生成、レンダリング、診断、Drive 連携
  - 失敗したページを個別に記録し、全体の再試行を可能にする
- 目的
  - Playwright や HTTP/Google Drive API の重い処理を Vercel から分離し、再実行可能性と監視性を高める

### 3. packages/shared

- 役割
  - `JobStatus`, `StageName`, `DiagnosticResult` などの共有型
  - Graph ノード/エッジの型
  - API リクエスト/レスポンス形式の定義
- 目的
  - web と worker の境界を明確にし、型の不整合を防ぐ

### 4. packages/config

- 役割
  - CDN マッピング一覧
  - ドメイン判定ルール
  - 既知ライブラリの変換設定
  - ルールベースの静的化設定
- 目的
  - 変換と診断の判断ロジックをコードから分離して再利用可能にする

### 5. infra

- 役割
  - Supabase の SQL/DDL
  - Railway のジョブ/Redis 構成
  - Google Drive 配置ルールやサービスアカウント設定
- 目的
  - インフラとアプリロジックの責務分離を行い、再デプロイ可能な構成にする

### 6. docs

- 役割
  - アーキテクチャ設計
  - 運用ルール
  - 診断指針
  - 成果物の命名規約
- 目的
  - 実装と運用ルールを組織横断で共有する

---

## 技術選定表

| 領域 | 選定技術 | 理由 | 補足 |
| --- | --- | --- | --- |
| フロントエンド | Next.js 15 (App Router) | App Router と API Routes を使って UI とジョブ制御を一体化しやすい | Vercel へのデプロイに適している |
| UI | Tailwind + shadcn/ui | 高速開発、保守しやすいダッシュボード構成 | 進捗・診断結果の表示に適する |
| バックエンド/ジョブ | Node.js + TypeScript | Worker での非同期処理と Playwright 連携に適している | 型安全性を確保しやすい |
| 依頼キュー | BullMQ + Redis | ジョブ実行、ステージ管理、再試行に向いている | `convert-site` のステージ制御に自然 |
| HTML取得/レンダリング | Playwright | JS 実行後の DOM を正確に取得できる | 無限スクロール・lazy load に対応可能 |
| HTML解析 | Cheerio |  DOM のメタ解析、有効なリンク抽出、静的化前の軽量検査に向く | Playwright の重い処理と分離できる |
| データベース | Supabase PostgreSQL | ジョブ管理・Graph保存・診断結果の永続化に適する | 低コストで運用しやすい |
| ストレージ | Google Drive | current/archive 運用と静的ファイル配布の簡易性が高い | `/sites/{siteKey}` 配下に管理しやすい |
| リアルタイム通知 | Server-Sent Events | SSE でステージ進捗・診断完了を簡潔に配信できる | `Last-Event-ID` で再接続に対応可能 |
| デプロイ | Vercel + Railway | UI と重い処理を分離して運用しやすい | 組織運用に適した責務分離 |

---

## 想定ディレクトリ構成

```txt
.
├─ apps/
│  ├─ web/                  # Next.js (UI + API + SSE)
│  └─ worker/               # BullMQ Worker (Playwright)
├─ packages/
│  ├─ shared/               # 型定義・Graph/Job/Diagnostic schema
│  └─ config/               # CDNマップ・ドメイン判定・ルール設定
├─ infra/
│  ├─ supabase/             # SQL/DDL
│  ├─ railway/              # デプロイ補助・ジョブ設定
│  └─ gdrive/               # Drive 配置ポリシー
├─ docs/
│  ├─ architecture/         # アーキテクチャ設計
│  ├─ operations/           # 運用手順
│  └─ diagnostics/          # 診断ルール
└─ README.md
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

## ローカル開発（Docker Compose）

ローカルで Web / Worker / Redis / PostgreSQL をまとめて起動できます。

### 1. 環境変数を作成

```bash
cp .env.example .env
```

`GOOGLE_DRIVE_ENABLED=false` のままなら、Drive 連携を無効化したローカル検証モードで起動できます。  
実際に Drive へアップロードしたい場合は `GOOGLE_DRIVE_ENABLED=true` にし、`GOOGLE_SERVICE_ACCOUNT_KEY` と `GOOGLE_DRIVE_ROOT_FOLDER_ID` を設定してください。

Drive の準備:

- `GOOGLE_SERVICE_ACCOUNT_KEY` には、サービスアカウント鍵の JSON の中身を 1 行にしたもの（例: `jq -c . key.json` の出力）を設定します。`.env` ではシングルクォートで囲んでください。
- 保存先には **共有ドライブ** 内のフォルダを使ってください。サービスアカウントは自身のストレージ容量を持たないため、マイドライブのフォルダにはアップロードできません。
- 共有ドライブのメンバーに、サービスアカウントのメールアドレス（鍵 JSON の `client_email`）を **コンテンツ管理者** 以上で追加してください（`current` を `archive` へ移動するのに必要です）。
- `GOOGLE_DRIVE_ROOT_FOLDER_ID` には、共有ドライブ内のルートフォルダの ID（URL の `folders/` 以降）を設定します。

変換結果の保存先:

- `GOOGLE_DRIVE_ENABLED=true`: Drive の `{GOOGLE_DRIVE_ROOT_FOLDER_ID}/sites/{siteKey}/current/`（以前の `current` は `archive/{timestamp}/` へ退避）
- `GOOGLE_DRIVE_ENABLED=false`: Worker コンテナの `/workspace/output/sites/{siteKey}/current/`（ホストではリポジトリ直下の `output/`）。退避ルールは Drive と同じです。

その他の Worker 設定（任意）: `MAX_PAGES`（既定 99）、`RESPECT_ROBOTS_TXT`（既定 `true`）、`LOCAL_OUTPUT_DIR`。

処理の流れ: Web (`POST /api/jobs`) が BullMQ の `convert-site` キューへ投入 → Worker が 7 ステージを実行し、ジョブ状態とイベントを Redis（Stream）へ書き込む → Web の SSE (`/api/jobs/:id/events`) がその Stream を配信します。

### 2. 起動

```bash
docker compose up --build
```

依存パッケージを追加・更新した後は、`node_modules` 用の名前付きボリュームが古いまま残るため、作り直してから起動してください。

```bash
docker compose down
docker volume rm wptossg_root_node_modules wptossg_web_node_modules wptossg_worker_node_modules
docker compose up --build
```

起動後:

- Web UI: `http://localhost:3000`
- Worker health: `http://localhost:4001/healthz`
- PostgreSQL: `localhost:5432`
- Redis: `localhost:6379`

### 3. 動作確認

1. Web UI からジョブを作成する
2. SSE エンドポイント（`/api/jobs/:id/events`）で進捗イベントが流れることを確認する
3. `docker compose logs -f worker` で Redis/PostgreSQL 接続チェックログを確認する

### 4. よくあるエラー

- `web` / `worker` が依存サービス待ちになる  
  → `docker compose ps` で `postgres` と `redis` の health が `healthy` になるまで待機してください。
- Drive 関連の環境変数未設定エラー  
  → ローカルでは `GOOGLE_DRIVE_ENABLED=false` を利用してください。

---

## クラウド環境で必要な主な環境変数（例）

- `DATABASE_URL`
- `REDIS_URL`
- `GOOGLE_SERVICE_ACCOUNT_KEY`
- `GOOGLE_DRIVE_ROOT_FOLDER_ID`
- `NEXT_PUBLIC_APP_URL`

サイト一覧・履歴のDB初期設定と既存成果物の補完手順は [docs/site-history.md](docs/site-history.md) を参照してください。

### 成果物の公開配信

Drive 保存時・ローカル保存時（`GOOGLE_DRIVE_ENABLED=false`）ともに `/sites/example.com/` からログイン不要で閲覧できます。
子ページも `/sites/example.com/about/` で直接参照できます。
旧版は `/sites/example.com/?archive=2026-10-15T00%3A00%3A00.000Z` のように
Drive の `archive` 配下のディレクトリ名を指定します。存在しない世代は 404 です。

Web に `WORKER_PUBLIC_URL`（例: `http://worker:4001`）を設定してください。
この URL は Worker の HTTP サービスを指します。Docker Compose では設定済みです。
Drive の認証環境変数は引き続き Worker のみに設定します。
Web と Worker が別ドメインの場合も、閲覧者は Web の `/sites/` を使用します。
配信レスポンスは `no-store` で、公開切替直後に新しい世代を読み出します。
HTML は管理画面の Cookie やストレージにアクセスできない sandbox 内で動作します。

アップロード先は `pending-{jobId}` です。アップロードと report 保存の完了後に
旧 `current` を archive へ移し、一時フォルダを `current` に変更して公開先を切り替えます。
公開先はサイトフォルダの Drive `appProperties.publishedFolderId` で管理し、
ローテーション中も直前の公開フォルダを ID で読み出せます。
失敗した一時フォルダは調査用に残り、公開配信の対象にはなりません。
既存の成功済みサイトは公開ポインタがない場合 `current` から配信します。

検証: `npm run build:worker && node scripts/test-public-sites.mjs`。

ローカル保存時は Worker の `LOCAL_OUTPUT_DIR/sites/{siteKey}/current` から配信します。
旧版は同じサイトの `archive` 配下のディレクトリ名を `?archive=` に指定します。
既に保存済みの成果物も、サイト一覧に登録済みであれば再生成せず閲覧できます。
Web にファイルを複製する必要はありません。Worker が保存先を読み出せる状態で起動してください。
ローカル配信の検証: `npm run build:worker && node scripts/test-local-public-sites.mjs`。
