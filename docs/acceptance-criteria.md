# 受入条件と検証手順

この文書は Issue 2 の「Issue 11: 受入条件と検証手順を整備する」を対応するものです。  
MVP の完了条件（`docs/requirements-and-boundaries.md` 参照）を検証するための具体的な確認手順を定義します。

---

## AC-1: 100ページ未満の単一サイトで完走できること

### 受入条件

単一の公開 WordPress サイトを対象として、100 ページ未満でパイプラインが全ステージ（PRECHECK → CRAWL_GRAPH → RENDER_AND_SNAPSHOT → ASSET_FETCH_AND_REWRITE → DIAGNOSTIC → ROTATE_AND_UPLOAD → FINALIZE）を完走し、ジョブステータスが `completed` になること。

### 検証手順

1. Web UI（`http://localhost:3000`）を開く
2. 「対象サイト URL」フィールドに対象の WordPress サイト URL を入力する（例: `https://example.com`）
3. 「ジョブを作成する」ボタンをクリックする
4. SSE 接続状態が「接続済み」になっていることを確認する
5. イベントログに以下のステージが順に記録されることを確認する:
   - `PRECHECK` → `job_state_changed`
   - `CRAWL_GRAPH` → `job_state_changed`
   - `RENDER_AND_SNAPSHOT` → `job_state_changed`
   - `ASSET_FETCH_AND_REWRITE` → `job_state_changed`
   - `DIAGNOSTIC` → `job_state_changed`
   - `ROTATE_AND_UPLOAD` → `job_state_changed`
   - `FINALIZE` → `completed`
6. 進捗バーが 100% に達することを確認する
7. 「状態」表示が `completed` になることを確認する
8. 最終レポートセクションに `successCount > 0` が表示されることを確認する

### 合格基準

- ジョブが `failed` にならず `completed` で終了する
- `FINALIZE` ステージまで全ステージが実行される
- イベントログに `completed` イベントが記録される

---

## AC-2: 2回目実行でarchiveローテーションが成功すること

### 受入条件

同一サイトを対象に 2 回目のジョブを実行した際、前回の `current` フォルダが `archive/{isoTimestamp}` へ退避され、新しい `current` フォルダが作成されること。

### 検証手順

#### 前提条件

- Google Drive のサービスアカウント鍵（`GOOGLE_SERVICE_ACCOUNT_KEY`）と  
  ルートフォルダ ID（`GOOGLE_DRIVE_ROOT_FOLDER_ID`）が Worker に設定されていること

#### 1回目の実行

1. Web UI でジョブを作成し、完走させる（AC-1 と同様の手順）
2. Google Drive の `/sites/{siteKey}/current/` にファイルが配置されていることを確認する
3. `archive/` フォルダが存在しないことを確認する（初回実行のため）

#### 2回目の実行

4. 同じ URL で再度ジョブを作成し、完走させる
5. イベントログに `ROTATE_AND_UPLOAD` ステージで以下のメッセージが記録されることを確認する:
   - `Existing current folder archived`（archiveFolderId を含む）
   - `New current folder created`
6. Google Drive の `/sites/{siteKey}/archive/{isoTimestamp}/` に前回の成果物が退避されていることを確認する
7. `/sites/{siteKey}/current/` に新しいファイル一式が配置されていることを確認する

### 合格基準

- 2 回目の実行で `archiveFolderId` がイベントに含まれる
- Google Drive に `archive/{isoTimestamp}` フォルダが存在する
- `archive/` に前回の `report.json` が含まれている
- 新しい `current/` に最新の `report.json` が存在する

---

## AC-3: SSEで進捗受信できること

### 受入条件

Web UI がジョブ実行中に SSE（Server-Sent Events）経由でリアルタイムにステージ進捗・ページ完了・警告などのイベントを受信し、画面に反映されること。また再接続（`Last-Event-ID`）とハートビートが機能すること。

### 検証手順

#### 基本動作確認

1. ブラウザの開発者ツール（Network タブ）を開く
2. Web UI でジョブを作成する
3. Network タブで `/api/jobs/{id}/events` の EventStream を選択する
4. 以下のイベントタイプが流れてくることを確認する:
   - `job_state_changed`
   - `stage_progress`
   - `page_done`
   - `warning`（該当ある場合）
   - `diagnostic_ready`
   - `completed`
5. 各イベントに `id:` フィールドが含まれることを確認する
6. 15 秒以上待機し、`: heartbeat {isoTimestamp}` コメントが定期送信されることを確認する

#### 再接続確認

7. ジョブ実行中にブラウザのネットワーク接続を一時的に切断する
8. 接続を復元すると SSE 接続状態が「再接続中」→「接続済み」に戻ることを確認する
9. 切断中に発生したイベントが再接続後に受信されることを確認する（`Last-Event-ID` ヘッダー利用）

#### curl による直接確認（任意）

```bash
curl -N -H "Accept: text/event-stream" \
  http://localhost:3000/api/jobs/{JOB_ID}/events
```

上記コマンドで SSE イベントが流れてくることを確認する。

### 合格基準

- SSE 接続状態が「接続済み」になる
- ジョブ完了まで全イベントが受信される
- ハートビートコメントが定期的に送信される
- ジョブ完了後、SSE 接続が正常にクローズされる
- `completed` または `failed` イベント受信後に接続状態が「接続終了」になる

---

## AC-4: 診断結果がUIに表示されること

### 受入条件

DIAGNOSTIC ステージ完了後、`risk_level` / `reasons` / `evidence` を含む診断結果が Web UI の「診断結果」セクションに表示されること。

### 検証手順

1. Web UI でジョブを作成し実行する
2. DIAGNOSTIC ステージ実行中、イベントログに `diagnostic_ready` イベントが記録されることを確認する
3. `diagnostic_ready` イベントの `details.diagnostic` に以下が含まれることを確認する:
   - `riskLevel`: `"low"` | `"medium"` | `"high"` のいずれか
   - `reasons`: 文字列の配列（空でもよい）
   - `evidence`: エビデンスオブジェクトの配列
4. Web UI の右側の「診断結果」セクションに以下が表示されることを確認する:
   - `risk:` の後に `low` / `medium` / `high` が表示される
   - reasons の各項目がリスト表示される
   - evidence の各項目（type / location）が表示される
5. evidence の各項目には断定ではなく根拠（`type: 'url' | 'selector' | 'api' | 'pattern'`）が含まれることを確認する

#### ハイリスクサイトの確認（任意）

ログインや会員向けと思われる URL（例: `https://login.example.com` や `https://example.com/account`）を入力してジョブを作成した場合、`riskLevel: 'high'` が返されることを確認する。

### 合格基準

- `diagnostic_ready` イベントが発行される
- `riskLevel` に `"low"` / `"medium"` / `"high"` のいずれかが設定される
- `reasons` 配列に根拠文字列が含まれる（リスクなしの場合は空配列も許容）
- `evidence` 配列に `type` と `location` を持つオブジェクトが含まれる
- Web UI の「診断結果」セクションに `riskLevel` が表示される

---

## 関連ドキュメント

- [要件と責務境界](./requirements-and-boundaries.md) — 完了条件の定義元
- [実装計画](./implementation-plan.md) — 各ステージの実装方針
- [AGENTS.md](../AGENTS.md) — パイプライン設計と診断方針
