# サイト一覧のDB設定と既存データ補完

Web / Worker ともにサーバー側の `DATABASE_URL` を設定する。ローカルComposeの既定値は `postgresql://wptossg:wptossg@postgres:5432/wptossg`。ユーザー名とパスワードは `POSTGRES_USER` / `POSTGRES_PASSWORD` に合わせる。変更後は `docker compose up -d --force-recreate web worker` で接続設定を反映する。Supabase はサーバー用接続文字列を使い、ブラウザには公開しない。
初回起動前に `infra/supabase/001_sites.sql` を対象DBで実行する。

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/supabase/001_sites.sql
```

`saved_sites.site_key` は既存 `createSiteKey` と同一（ホスト名をフォルダ名に変換）で、パスやスキームが異なっても同じサイトとしてまとめる。既存キーの衝突仕様も引き継ぐ。
`site_versions` はジョブIDを変換版IDとして使い、再登録を冪等にする。Graph・診断・report・成果物場所を保存し、Redis の7日保持とは独立して残す。サイト名はドメインを使う。
最新版の更新対象は、完了した変換で、成果物アップロード失敗がなく、report.json の保存も成功したもの。ページ単位の部分失敗は処理結果に残る。DB登録失敗時はジョブの warning に残し、既存の変換・SSEは継続する。
履歴APIは `GET /api/sites/:siteKey` の `versions` に含む。一覧は `GET /api/sites`。管理画面は `/list`、サイト詳細は `/list/{siteKey}`。
`source` は `conversion | ai-edit`。後続のAI編集は独立した版IDと元ジョブIDを使い、保存が完了してから同じDBトランザクションで最新版を更新する。編集案を直接登録しない。

既存成果物は自動推測で取り込まない。運用者が `report.json` と `graph.json`、Drive/ローカルの実在場所を確認し、Job形式のJSON配列を作成する。

- `id`, `siteUrl`, `status: completed`, `report` を補完する。`report.generatedAt` は実際の保存日時を使う。
- `diagnostic` と `graph` は保存済み成果物から補完する。
- `report.storage` に `backend`, `currentFolderId`, `currentLocation` を実在場所から設定する。
- サイトごとに保存順で取り込む。次の版の `archiveFolderId` は直前の版の実在する退避先を設定する。不明な場合は過去版のアクセスを利用不可にする。
- アップロード失敗があるものや、保存成功を確認できないものは取り込まない。

```sh
npm --workspace packages/shared run build
node scripts/backfill-sites.mjs /path/to/verified-jobs.json
```

補完はSQLと同じDB接続権限で実行する。ファイルの移動やDriveの変更は行わない。
ローカル成果物はWorker上のパスを表示する。ローカル・Driveともに `/sites/{元サイトのドメイン}/` で公開配信し、詳細画面に公開リンクを表示する。過去版は `?archive={archiveディレクトリ名}` を指定する。Driveのフォルダリンクも表示する。
同一サイトの同時変換について、ストレージの既存ローテーションの排他仕様は本変更で拡張していない。

検証スクリプト:

```sh
# マイグレーション適用済みの検証DBを指定。作成したテスト用レコードのみ終了時に削除する。
node scripts/test-site-store.mjs
# production build を port 3000 で起動後、Chromium が利用可能な環境で実行する。
node scripts/test-sites-ui.mjs
```
