# GitHub Pages 移行メモ

## 結論

このアプリは静的HTMLとGoogle Drive APIだけで動くため、GitHub Pagesへそのまま配置できます。

| 項目 | 設定 |
|---|---|
| 配置ファイル | `index.html` と `.nojekyll` |
| Pages source | `Deploy from a branch` |
| Branch | `main` |
| Folder | `/root` |
| Google OAuth | デプロイ後の `https://ユーザー名.github.io/リポジトリ名` を承認済みJavaScript生成元へ追加 |

## 手順

| 順番 | 作業 |
|---|---|
| 1 | GitHubで新しいリポジトリを作成します。 |
| 2 | このフォルダ内の `index.html` と `.nojekyll` をリポジトリ直下へ配置します。 |
| 3 | GitHubの Settings から Pages を開き、`Deploy from a branch` を選びます。 |
| 4 | `main` と `/root` を選んで保存します。 |
| 5 | 表示された Pages URL を開き、アプリの設定画面に表示されるURLをコピーします。 |
| 6 | Google Cloud Console の OAuth クライアントで、承認済みJavaScript生成元へそのURLを追加します。 |
| 7 | アプリへ戻り、Googleアカウントでログインします。 |

## 注意

| 項目 | 内容 |
|---|---|
| URL変更 | NetlifyからGitHub Pagesへ移すとoriginが変わるため、Google OAuth側に新URLの追加が必要です。 |
| ローカルファイル | `file://` で開いた状態ではGoogleログインできません。 |
| 同期方式 | 完全なプッシュ同期ではなく、保存時、画面復帰時、45秒ごとの軽い同期を使います。 |
| データ保存先 | 投稿データはGitHub Pagesではなく、Google Drive内の `diary_data.json` に保存されます。 |

## URL要約

| 項目 | 内容 |
|---|---|
| OGP取得 | Cloudflare Worker がURL先のHTMLを取得し、タイトル、説明、画像、本文抜粋を返します。 |
| AI要約 | Worker のシークレットに `GEMINI_API_KEY` がある場合は Gemini 3.5 Flash を優先して要約します。 |
| 代替処理 | Gemini APIが使えない場合は Workers AI、最後に本文抜粋ベースの要約へフォールバックします。 |
| キャッシュ | 要約結果が古く残らないよう、WorkerのJSONレスポンスは `Cache-Control: no-store` にしています。 |
