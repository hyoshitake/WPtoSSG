# Issue #19: AI編集の設計と運用

## 採用した利用条件

OpenAI Responses APIをWorkerから使用する。アプリ内の金額上限・日次予算は設けず、OpenAIからの利用上限・レート制限エラーを表示する。有料APIの自動再試行は行わない。修正指示と必要なHTML/CSS/SVGを送信する。APIキーはWorker環境変数のみに保持し、応答本文・キー・指示文をログに出さない。`store:false`を指定する。

`OPENAI_EDIT_MODEL=auto`はアプリの既定モデル選択であり、APIに`auto`というモデル名を送信しない。現在の既定値は`gpt-6.1-sol`。環境変数で明示的なモデルIDにも変更できる。使用したモデルと入出力トークン数を修正案に記録する。

参考: [モデル一覧](https://developers.openai.com/api/docs/models)、[Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)、[Web search](https://developers.openai.com/api/docs/guides/tools-web-search)。

URLだけを渡しても、取得内容の入力トークンが不要になるわけではない。Web検索では元のHTML/CSSの正確な取得も保証できない。そこで、編集可能なソース合計が12 KiB以下なら直接送信し、それより大きければファイル一覧を送り、AIが`read_site_file`で必要なソースだけ取得する。同じ基準版の成果物をWorkerが返すため、ホスティング公開や検索APIは不要。これは送信量を減らすためのヒューリスティックであり、両方式を有料で実行して比較するものではなく、最少トークン数を保証しない。

技術的な処理制限は生成120秒、指示4,000文字、変更20ファイル、AIへのソース取得合計200 KiB、変更出力100 KiB。成果物全体は50 MiB・3,000ファイルまで。画像は既存画像の参照・配置変更とSVG編集に対応し、新規のラスター画像生成は行わない。JavaScriptやサーバーコードの新規生成は対象外。既存のバイナリ・JavaScriptは保持する。

ファイル一覧には`readable`と`editable`を明示する。JS/JSON/TXT/XMLは文脈確認のため読込可能だが、編集はHTML/CSS/SVGに限定する。存在しないパスやバイナリの読込要求にはツールエラーを返し、既存の回数・時間制限内でAIが参照を修正できるようにする。参照エラーはwarningイベントに記録し、元ファイル未確認の変更は引き続き拒否する。

## 起動手順

1. `infra/supabase/001_sites.sql`に続いて`002_ai_edits.sql`を対象DBに適用する。変換も共通の排他制御を使用するため、Web/Workerの更新前に適用する。
2. Workerに`OPENAI_API_KEY`、`OPENAI_EDIT_MODEL=auto`を設定する。
3. `PREVIEW_PUBLIC_ORIGIN`をブラウザから接続できるWorker配信のオリジンに設定する。ローカル既定値は`http://localhost:4001`。本番は管理画面と異なるオリジンのHTTPSを用意し、`/edit-preview/*`だけを外部公開する。管理画面の認証Cookieを共有しない。
4. `npm run build:worker`と`NODE_ENV=production npm run build:web`でビルドし、Web/Workerを起動する。Composeでは環境変数の変更後に`docker compose up -d --force-recreate web worker`で反映する。
5. 一覧の「AIで編集」または編集メニューからサイトを選び、指示を入力する。変更概要・変更ファイル・プレビューを確認してチェックを入れると保存できる。

プレビューはWorkerが配信する。管理画面と同じオリジンのURLはUIで表示しない。iframe sandboxと配信側CSP sandboxの両方でsame-origin権限、フォーム送信、親画面遷移、ポップアップを許可しない。CSPは接続・Worker・埋め込みフレームも制限する。リンクとCSS/画像は案ごとの名前空間へ書き換える。アクセスにはランダムな修正案トークンが必要で、破棄した案は配信しない。プレビューURLは共有しない。

## データと処理

Web/BFFは対象選択、指示受付、SSE、変更一覧、プレビュー、保存・破棄の受付を担当する。WorkerはAI Adapter、成果物読込、検証、Playwright実行、診断、Graph再構築、Drive書き込みを担当する。

`site_edits`に状態、基準版ID、元変換ジョブID、親修正案ID、指示、変更概要・ハッシュ、使用量、成果物、診断、保存操作を永続化する。成果物はbase64の非公開JSONとして保持するため、Workerの再起動や別インスタンスでも取得できる。既存の`site_versions`には保存成功版だけを追加し、元変換ジョブ・編集ジョブ・基準版・修正案IDを対応付ける。既存成果物の一覧補完は[site-history.md](site-history.md)の手順を使い、読込時にcurrent内のreportとDB版のジョブIDを照合する。不一致なら再変換・メタデータ補完を案内する。

編集はLOAD_BASE、GENERATE、VALIDATE、PREVIEW_READY、SAVE、FINALIZEを使用する。既存convert-siteの7ステージは維持する。イベントは`edit_job_events`へ永続化し、既存のRedis stream/SSEにも配信する。Last-Event-ID・15秒heartbeatを継続利用する。保存操作ごとのoperationIdで、過去の生成完了イベントによって保存のSSEが終了することを防ぐ。Redisの保持期限後も案・診断・直近50イベントはDBから取得できる。画面は通信障害に備えてDB状態も定期取得する。

AIの応答は構造化されたテキストパッチとして受け取り、任意コマンドを実行しない。絶対パス・親ディレクトリ参照・重複ファイル・制限超過・曖昧な置換を拒否する。追加ページのGraph、リンク、アセット参照、配信用マニフェストを再構築する。基準版から存在する欠損参照は警告、新たな欠損参照は失敗にする。WorkerのPlaywrightは成果物をメモリから配信し、外部通信を遮断して検証する。静的解析とレンダリングからriskLevel（画面上はrisk_level）、reasons、evidenceを生成し、report.jsonに反映する。

## 保存・再試行・復旧

PostgreSQLのサイト単位advisory lockを変換と編集保存で共有し、複数Workerでも直列化する。保存時に基準版と最新版を比較し、不一致は再読込・再生成を案内する。案の生成・再指示はcurrentを変更しない。再指示は親修正案から新しい案を作り、変更一覧は基準版からの累積差分を示す。

保存は修正案IDを冪等キーとする。保存済みの要求は既存結果を返す。保存先・旧版・新版のIDと処理段階をDBに記録し、pendingに新版とreport.jsonを準備してから旧currentをarchiveへ移動する。ローカルは新版のマーカーファイル、DriveはpublishedFolderIdにより、ストレージ更新後のDB障害も識別する。再試行は同じ保存計画とフォルダIDを使用し、二重archiveを作らない。Driveは公開ポインタで旧版を配信し続け、ローカルの切替失敗時は旧版をcurrentへ戻す。

保存成功後、DBトランザクションで旧版のarchive参照・新しい版・一覧の最新ポインタ・保存結果を更新する。保存途中の案があれば別の変換・編集保存を拒否し、元の案の保存再試行を案内する。保存を開始した案は復旧完了まで破棄できない。

保存失敗時は案を開き「保存を再試行」を選ぶ。通信断やキュー登録失敗でsavingのままなら「保存状態を再確認・再試行」を使う。生成失敗は指示を見直して新しい生成を開始する。Worker停止中の生成の自動再開では有料生成を繰り返さず、失敗を表示して再生成を案内する。未完了の保存計画を手動削除して他のジョブを通さない。DBとストレージのバックアップを併せて保持する。

## 検証

```sh
# マイグレーション済みの検証DB、ビルド済みWorker、Chromiumが必要。
# OpenAIは模擬応答を使用し、有料APIを呼ばない。
node scripts/test-ai-edit.mjs
node scripts/test-ai-source-reads.mjs
TEST_APP_URL=http://localhost:3000 node scripts/test-ai-edit-api.mjs
TEST_APP_URL=http://localhost:3000 node scripts/test-ai-edit-ui.mjs
node scripts/test-site-store.mjs
node scripts/test-public-sites.mjs
node scripts/test-local-public-sites.mjs
```

実APIの疎通と実Driveへの書き込みは、運用環境の認証情報を設定した後、検証用サイトで別途確認する。プレビューURLは有効期限による自動削除を行わず、案の破棄で失効する。成果物をDBに保持するため、大きなサイトや修正案が増える環境では容量を監視し、不要な案を破棄する。
