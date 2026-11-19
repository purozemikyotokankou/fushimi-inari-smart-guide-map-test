# 伏見稲荷スマートガイド — MapLibreテスト環境 V163

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

この版ではMapLibreの3Dカメラを有効にしています。初期表示はpitch 48度で、画面左上の「2D」ボタンから真上表示に切り替えられます。スマホは2本指操作で傾き・回転を調整できます。既存のLeaflet参道線・案内線は投影変換でMapLibreのカメラに追従させ、スポットSVGアイコンは正立したまま再配置します。OpenFreeMap Positronが建物ベクターレイヤーを公開している場合は、建物の3D押し出しレイヤーも追加します。GPSナビ中は、位置情報の進行方向が十分な精度で取れた場合に地図の向きを合わせます。 なお、伏見稲荷の山の起伏そのものを標高データで立体化する地形3D（Terrain DEM）はこの版には含めていません。

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

1. `fushimi_metamap_v163_maplibre_3d_test.zip` をPCに保存して展開します。
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

- MapLibre GL JS 5.7.1 (3D camera enabled) (BSD-3-Clause): https://maplibre.org/maplibre-gl-js/docs/
- OpenFreeMap Positron: https://openfreemap.org/ （公開スタイルURL: `https://tiles.openfreemap.org/styles/positron`）
- OpenFreeMap / OpenMapTiles / OpenStreetMap attribution: MapLibreの標準帰属表示を地図右下に表示します。
- OpenStreetMap data: ODbL. OpenFreeMapの利用条件も確認してください: https://openfreemap.org/terms/

作成日: 2026-11-19
