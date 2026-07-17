# Weather Auto Post Apps Script

## 結論

Google Apps Scriptで毎朝6時台に、東京・新宿の今日と明日の天気、朝昼晩の服装メモを `diary_data.json` へ自動投稿します。

| 項目 | 内容 |
|---|---|
| 天気API | Open-Meteo JMA API |
| 地点 | 東京・新宿、緯度 `35.6896`、経度 `139.7006` |
| 投稿先 | Google Drive の `MyPrivateSanctuary_Sync/diary_data.json` |
| 投稿ID | `auto-weather-YYYY-MM-DD` |
| 重複対策 | 同じ日の自動投稿は上書き更新 |
| AI | `GEMINI_API_KEY` がある場合だけ文章化に使用 |
| Apps Script | https://script.google.com/d/183q2615O5ubIC4P1VrvUULNIApBwtR-h9NOF-_MKcUOCmdAZyqZTK0JT/edit |

## セットアップ

| 手順 | 作業 |
|---|---|
| 1 | Google Driveと同じGoogleアカウントで [Apps Script](https://script.google.com/) を開き、新しいプロジェクトを作成します。 |
| 2 | `Code.gs` の内容をApps Scriptの `Code.gs` へ貼り付けます。 |
| 3 | Apps Scriptのプロジェクト設定で `appsscript.json` を表示し、このフォルダの `appsscript.json` の内容に置き換えます。 |
| 4 | まず `runWeatherOutfitOnceForTest` を手動実行し、権限を承認します。 |
| 5 | 日記アプリで今日の投稿に天気メモが追加されることを確認します。 |
| 6 | 問題なければ `installMorningWeatherTrigger` を一度だけ実行します。 |

## Geminiを使う場合

| 設定キー | 内容 |
|---|---|
| `GEMINI_API_KEY` | Google AI Studioなどで発行したAPIキー |
| `GEMINI_MODEL` | 任意。未設定なら `gemini-2.5-flash` |

Apps Scriptの左メニューから「プロジェクトの設定」を開き、「スクリプト プロパティ」に上記キーを追加します。AIキー未設定でも、ルールベースの投稿は動きます。

## 投稿内容

| 区分 | 集計時間 |
|---|---|
| 朝 | 6〜9時 |
| 昼 | 11〜15時 |
| 晩 | 18〜22時 |

服装は気温を中心に短く判定し、メモ欄には湿度、風、雨の注意だけを簡潔に出します。

| 条件 | 補正 |
|---|---|
| 気温が高い | Tシャツのみ |
| 気温が低い | ジャケットまたはダウン |
| 雨の可能性がある | メモ欄に降水確率を表示 |
| 雨の可能性が低い | 雨なし表現は表示しない |

## 注意

| 項目 | 内容 |
|---|---|
| 実行時刻 | Apps Scriptの時間主導トリガーは6時台に実行されます。秒単位の厳密な6:00実行ではありません。 |
| 同期 | 日記アプリ側は次回同期時にApps Scriptの投稿を取り込みます。 |
| データ競合 | 同じ `id` の投稿を更新する方式なので、毎日1件だけ天気投稿が残ります。 |
| API制限 | Open-Meteoが429を返した場合は、1時間後に `retryDailyWeatherOutfit` が最大3回まで自動再試行します。 |
| 一時トリガー | 429後だけトリガー一覧に `retryDailyWeatherOutfit` が一時的に表示され、成功後に自動削除されます。 |
| 帰属 | 投稿末尾に `Weather data by Open-Meteo.com` を付けています。 |
