# 伏見稲荷スマートガイド — MapLibreテスト環境 V162

このフォルダは、本番サイトとは別のGitHubリポジトリで新しい地図を試すための完全なテスト用プロジェクトです。

## 今回の変更

- ルート画面（`planner.html`）の地図エンジン表示部分を Leaflet のラスタータイルから **MapLibre GL JS + OpenFreeMap Positron** に変更。
- 既存のスポットSVG、カテゴリ色、スポット座標、`data/spots.json`、`data/routes.json`、ルート検索処理は維持。
- 既存のLeaflet製マーカー・参道線・詳細表示・スポット選択・Apple風スポットパレットは透明オーバーレイとして継続利用。
- MapLibre側の地図ドラッグ・ズームをLeaflet側のオーバーレイに同期。
- ナビ中はGPS位置に合わせて地図中心を自動追従。地図を手動でドラッグすると追従を一時停止し、既存の「現在地」ボタンを押すと再開。
- 初期表示は中心 `34.96788994013442, 135.77865108489644`、ズーム17。
- `spots.html` にある旧スポット一覧ページの小型マップは、今回のテスト対象外で従来表示のままです。
- 本番リポジトリのファイルは変更していません。

## 重要な技術上の範囲

これは移行の第一段階です。現在のスポット・ルート描画はLeafletの座標投影に依存しているため、オーバーレイ位置のずれを防ぐ目的で、MapLibreの地図回転・3D傾斜はこのテストでは無効にしています。地図は北向きの2D表示です。GPS追従、既存の残距離・次の目的地表示を確認できます。現在地を画面下寄りに固定するカメラ、進行方向への自動回転、3D傾斜はまだ含めていません。これらはスポット・ルート描画をMapLibreネイティブレイヤーへ移植してから実装する次段階です。MapLibreネイティブの回転・3D表示は、スポット/ルート描画をMapLibreレイヤーへ移植した後の次段階です。

OpenFreeMapの公開インスタンスを使うため、地図表示にはインターネット接続が必要です。OpenFreeMap公式案内では、公開インスタンスはAPIキー・登録なしで利用でき、MapLibre利用時は必要な地図帰属表示が自動追加されます。

## GitHubでテストサイトを作る手順

### 1. 新しいリポジトリを作成

1. GitHubにログインします。
2. 画面右上の `+` → `New repository` を押します。
3. Repository name に `fushimi-inari-smart-guide-map-test` と入力します。
4. `Public` を選びます（GitHub FreeでGitHub Pagesを使うため）。
5. `Add a README file` はチェックしないでください。
6. `Create repository` を押します。

※ 既存の `fushimi-inari-smart-guide` は選ばないでください。本番とは別の新規リポジトリです。

### 2. ZIPを展開して中身をアップロード

1. `fushimi_metamap_v162_maplibre_test.zip` をPCに保存して展開します。
2. 展開してできたフォルダを開きます。
3. その中にある `index.html`、`planner.html`、`css`、`js`、`data`、`images`、`videos` などをすべて選択します。
4. 新しく作った空のGitHubリポジトリ画面で `uploading an existing file` を押します。
5. 選択したファイルとフォルダをアップロード欄へドラッグ＆ドロップします。
6. 下部の Commit changes を押します。

重要：ZIPファイルそのものをリポジトリにアップロードするのではありません。**ZIPを展開した中身**をアップロードします。中にあるフォルダ構成はそのまま保ってください。

### 3. GitHub Pagesを有効化

1. 新しいリポジトリの `Settings` を開きます。
2. 左メニューの `Pages` を開きます。
3. `Build and deployment` の `Source` を `Deploy from a branch` にします。
4. Branch を `main`、Folder を `/(root)` にします。
5. `Save` を押します。
6. Pages欄に公開URLが表示されたら開きます。

### 4. 新しいマップを開く

GitHubユーザー名が `purozemikyotokankou` の場合、テストマップURLは次の形です。

`https://purozemikyotokankou.github.io/fushimi-inari-smart-guide-map-test/planner.html`

最初は地図の読み込みに少し時間がかかる場合があります。地図が出ない場合は、ページを再読み込みして、ブラウザの開発者ツールConsoleに出る `[Fushimi Map Test]` のエラーを確認してください。

## テストしてほしい項目

1. `planner.html`を開くと新しい淡色ベクターマップ（OpenFreeMap Positron）が表示される。
2. マップをドラッグ・ホイール・ピンチで操作しても、スポットアイコンとオレンジ色の参道線が地図上からずれない。
3. 近接スポットのApple風パレットを開いて、候補を選べる。
4. スポット詳細・検索・保存済み・ルート作成が使える。
5. 現在地ボタンでGPS位置に移動する（HTTPSのGitHub Pages上で確認）。
6. ナビ開始後にGPS位置へ地図が追従する。手動で地図をドラッグした後は追従が一時停止し、現在地ボタンで再開する。
7. ルートを作成して、既存のオレンジ色ルート線と白いビームが表示される。

## 元の本番へ戻す必要はありません

このテストリポジトリだけにアップロードしてください。現在の本番リポジトリには何もアップロードしないでください。

## 依存先・ライセンス・帰属表示

- MapLibre GL JS 5.7.1 (BSD-3-Clause): https://maplibre.org/maplibre-gl-js/docs/
- OpenFreeMap Positron: https://openfreemap.org/ （公開スタイルURL: `https://tiles.openfreemap.org/styles/positron`）
- OpenFreeMap / OpenMapTiles / OpenStreetMap attribution: MapLibreの標準帰属表示を地図右下に表示します。
- OpenStreetMap data: ODbL. OpenFreeMapの利用条件も確認してください: https://openfreemap.org/terms/

作成日: 2026-11-19
