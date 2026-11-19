# 伏見稲荷スマートガイド — MapLibreテスト版 V162

これは本番サイトとは別のテスト用プロジェクトです。現在のアプリを土台に、ルート案内画面のベースマップを **MapLibre GL JS + OpenFreeMap Positron** に切り替えています。

## まず読むファイル

- **[TEST_SETUP_GUIDE_JA.md](./TEST_SETUP_GUIDE_JA.md)** — 新しいGitHubリポジトリの作り方、GitHub Pagesの公開方法、確認手順を画面順に説明しています。
- **[MAP_TEST_NOTES.txt](./MAP_TEST_NOTES.txt)** — テスト版の変更点と注意点です。

## 重要

- 既存の本番リポジトリには変更を加えていません。
- このZIPを新しく作るテスト用リポジトリにだけアップロードしてください。
- 地図タイルの表示にはインターネット接続が必要です。
- MapLibreのベース地図の上に、既存Leafletのスポット・参道レイヤーを重ねる互換方式です。地図回転・3D傾斜は、表示ずれを防ぐためこの初期テストでは無効です。詳細はガイドを確認してください。

## 入口

- 言語選択: `index.html`
- ホーム: `home.html`
- 新マップの確認: `planner.html`
