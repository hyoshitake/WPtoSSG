# AGENTS.md

このドキュメントは、WPtoSSG の実装に関わる人間/AIエージェント向けの作業ガイドです。  
目的は「WordPressサイトを安全に静的化し、再実行可能で観測可能なパイプラインを維持すること」です。

---

## 1. プロジェクトのゴール

- 公開中の WordPress サイト（ログイン不要）をクロールする
- サイトを Graph 構造で表現する（URL列挙だけにしない）
- ページを Playwright でレンダリング後に静的 HTML として保存する
- 同一ドメインのアセットを取得し、外部参照は原則維持する
- 変換結果を Google Drive に `current` / `archive` 運用で保管する
- 処理後に静的化困難性（API/フォーム/ログイン兆候）を診断する

---

## 2. システム境界

### Frontend / BFF (Vercel)
- Next.js 15 (App Router)
- Tailwind + shadcn/ui
- 役割: ジョブ作成、状態表示、SSE受信、結果表示

### Worker (Railway)
- Node.js + TypeScript
- BullMQ + Redis
- Playwright + Cheerio
- 役割: クロール、レンダリング、アセット処理、診断、Drive書き込み

### Database (Supabase PostgreSQL)
- ジョブ・イベント・Graph・診断・成果物メタ保存

### Storage (Google Drive)
- `/sites/{siteKey}/current`
- `/sites/{siteKey}/archive/{timestamp}`

---

## 3. 実装ルール（必須）

1. **重い処理は Worker に限定**
   - Playwright 実行を Vercel 側で行わない。

2. **ジョブは必ず冪等性を意識**
   - 同一URLの再実行で壊れないこと。
   - 部分失敗時に再試行可能な設計にすること。

3. **ステージごとのイベント記録**
   - 進捗、警告、失敗理由を `job_events` に残すこと。

4. **外部リンクは保持、内部のみ取得**
   - ドメイン判定を厳密に行うこと。

5. **Graph first**
   - URLリストだけで処理しない。ノード/エッジを持つ。

6. **Driveローテーションを崩さない**
   - 2回目以降は `current` を archive へ退避してから新 `current` を作る。

7. **診断は断定ではなく根拠付き**
   - `risk_level` と `evidence` を出力する。

---

## 4. BullMQ ジョブステージ

`convert-site` は以下の順で実行する:

1. `PRECHECK`
2. `CRAWL_GRAPH`
3. `RENDER_AND_SNAPSHOT`
4. `ASSET_FETCH_AND_REWRITE`
5. `DIAGNOSTIC`
6. `ROTATE_AND_UPLOAD`
7. `FINALIZE`

各ステージで `job_events` を発行すること。

---

## 5. クロール/レンダリング方針

- 最大対象規模: 100ページ未満（現行要件）
- 同一ドメイン配下を対象
- 多言語パス（例: `/ja`, `/en`）を通常ページとして扱う
- クエリURLは原則正規化（必要時のみ保持）
- 無限スクロール対応: 高さが増えなくなるまで最大N回スクロール
- lazy load 対応: `data-src`, `data-srcset` 等を展開してからスナップショット

---

## 6. 診断方針（静的化困難性）

以下のシグナルを収集する:

- 同ドメイン API 呼び出し（fetch/XHR）
- form 要素の存在
- ログイン要求の兆候（password input、login系URL、401/403）

出力:

- `risk_level`: `low | medium | high`
- `reasons`: 文字列配列
- `evidence`: URL、セレクタ、APIエンドポイントなど

---

## 7. SSE 方針

- エンドポイント: `GET /api/jobs/:id/events`
- Content-Type: `text/event-stream`
- 推奨イベント:
  - `job_state_changed`
  - `stage_progress`
  - `page_done`
  - `warning`
  - `diagnostic_ready`
  - `completed`
  - `failed`
- 再接続用に `Last-Event-ID` を扱う
- ハートビートを定期送信する

---

## 8. コーディング規約（推奨）

- TypeScript strict mode
- ESLint + Prettier
- `packages/shared` に型を集約（web/workerで共有）
- 外部I/O（DB/Redis/Drive/HTTP）は必ずAdapter層経由
- ログは構造化（JSON）で出力

---

## 9. 失敗時の扱い

- ページ単位失敗は収集して継続（ジョブ全体を即失敗させない）
- ただし初期到達不能（DNS/TLS/403連続等）はジョブ失敗
- 最終的に `report.json` を必ず生成し、成功/失敗内訳を残す

---

## 10. セキュリティ/運用

- Google サービスアカウント鍵は Worker 環境変数でのみ保持
- PIIやCookieなど機密情報をログに出さない
- robots.txt は尊重する（運用ポリシーで override 可能にする場合は明示）

---

## 11. 今後の拡張候補

- 差分クロール（前回Graphとの差分だけ処理）
- 既知ライブラリCDNマッピングの自動更新
- 画像最適化（WebP/AVIF）
- GCS/S3 等のストレージアダプタ追加

---

## 12. Definition of Done（MVP）

- 単一サイトを投入し、100ページ未満で完走できる
- `current` 配下に静的ファイル一式が配置される
- 2回目実行で archive ローテーションが成功する
- UI が SSE で進捗を受信できる
- 診断結果（risk + evidence）が表示される
