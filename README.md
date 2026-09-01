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

