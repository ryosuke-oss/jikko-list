# 実行リスト (jikko-list)

ブラウザの中で動く、自分専用のタスク管理アプリです。データは端末の中（IndexedDB）に保存し、同期をオンにすると、自分の Google ドライブのスプレッドシート1つを通して PC とスマホの中身をそろえます。
A personal task list that runs in the browser. Data stays on the device (IndexedDB); an optional sync keeps devices in step through one spreadsheet in the user's own Google Drive.

## できること

- 1行で追加：「研修資料の改訂 木曜 B 3日 教育部に確認」→ タスク名・期日・ランク・所要期間・確認ルートに分けて入る（入力中に結果を見せ、× で外せる）
- 複数行の貼り付けでまとめて追加（行頭の「- 」「・」「□」「1.」は外す）
- 確認ルート：1つのタスクに最大5段（確認／依頼／返信 × 相手 × まだ・待ち・済）。「待ち」にすると停止中、待ちがなくなると進行中に自動で変わる。一覧で「◯◯の返事待ち 2日」が分かる
- ランク A（考える）・B（調べればできる）・C（作業）と重要★、所要期間（1日・3日・1週間・1ヶ月）の印と絞り込み
- スマートリスト（今日・期限切れ・すべて・重要・停止中・あとで箱）と絞り込みメニュー
- ドラッグで並べ替え（スマホは長押し）。あとで箱は戻す日を決められる
- 今日の予定（今日だけの箇条書き）と目標（週・月・年）。期間が終わると自動で履歴へ移り、消えない
- メモ帳（→ でタスクにする）、竜の育成（経験値と5段階の姿）
- 書き出し（JSON）・読み込み・1日1回の自動の控え（7日分）・ゴミ箱
- 電波がなくても開ける：アプリの部品（HTML・CSS・JS・アイコン）を Service Worker でこの端末にしまっておく（[`public/sw.js`](public/sw.js)）。新しい版は、編集中でないときに自動で入れ替わる（設定に「いまの版」と［更新］）
- PC は3列、タブレットは2列、スマホは1列＋下のタブバー。どの幅でも横スクロールなし
- 同期（設定 → 同期。オンにしたときだけ）：PC とスマホの中身を、Google ドライブのスプレッドシート1つ（同期ファイル）を通してそろえる。電波がない間の変更は、つながったときに送る。2台で違う所を直したら両方入れ、同じ所を直したときと、合わせると何かが消えるときだけ「どちらを残す？」と聞く。同期ファイルには、端末ごとのタブに変更を1行ずつ下に足すだけ（前の行は書き換えない）

## データとセキュリティ

- **データはこの端末のブラウザの中（IndexedDB）に保存します。** このサイトのサーバーにデータは来ません。解析、広告、Cookie はありません
- **同期をオンにしたときだけ**、ログインした Google アカウントのドライブにある同期ファイル（このアプリが作ったスプレッドシート1つ）とやりとりします。通信先は `www.googleapis.com`（Drive）と `sheets.googleapis.com`（Sheets）の2つだけで、通信するのは [`public/js/sync/google.js`](public/js/sync/google.js) だけです。オフ・一時停止のときは Google と通信しません
- Google へのログインは、Google のログイン画面へページごと移動して戻ってくる方式です（Google のプログラムは読み込みません）。権限は `drive.file`（このアプリが作ったファイルだけ）。戻ってきたアドレスに付いた鍵（1時間で切れる）はすぐにアドレスから消し、この端末の中にだけ置きます。クライアントID はコードに書かず、使う人が設定で貼ります
- 外部のファイル（CDN・Webフォント）を読み込みません。部品もアイコンも同じ場所から配信します
- `Content-Security-Policy`（`default-src 'none'`・`connect-src 'self' https://sheets.googleapis.com https://www.googleapis.com`・`worker-src 'self'`）などのヘッダーで、それ以外との通信やページの埋め込みを止めています（[`public/_headers`](public/_headers)）。`'self'` は、自分のサイトの部品を端末にしまう Service Worker のためです
- 画面は `textContent` / `createElement` だけで組み立てます。`innerHTML` と `eval` は使いません
- リンクは `http://` と `https://` だけを保存し、`noopener noreferrer` で開きます
- 読み込むファイルは形式と版を確かめ、合わなければ1件も書き換えません。読み込みの直前の状態は自動で控えます
- サーバー側の処理や外から呼べる窓口（API）がない静的なサイトなので、サイト側の呼び出し回数の制限（レート制限）は入れていません。同期は、アプリの中で「最短10秒おき・1時間120回まで」に止めています（Google を呼び続けないため）
- 接続テスト用のページ [`/connect-test.html`](public/connect-test.html)（同期の準備・試験用）は、そのページ専用の CSP（Google の2つだけ）で動きます。送るのはテスト用の行だけで、アプリのタスクやメモは送りません

## 手元で動かす

```bash
python3 -m http.server 8787 --directory public
```

ブラウザで http://localhost:8787 を開きます（ファイルを直接開くと動きません）。

## テスト

```bash
npm test
```

Node.js 20 以上。1行の解釈・状態の連動・経験値の計算・期間の切り替え・読み込みの点検と、同期（版の名前・合流のルール・同期の流れ。Google の代わりにメモリの中の偽物を使い、2〜3台の同時操作・電波切れ・二重送信・手で触った行などを再現）を確かめます。

## 公開

`main` に push すると、Cloudflare Workers Builds が [`wrangler.jsonc`](wrangler.jsonc) の設定で `public/` フォルダだけを公開します。

`public/` の中を変えたら、push の前に次を実行します。Service Worker がしまう部品の一覧と版（中身から作る印）を `public/sw.js` に書き直します。忘れると `npm test` が失敗します（古い部品が端末に残り続けるのを防ぐため）。

```bash
npm run stamp
```

## 使っている部品

- [SortableJS](https://github.com/SortableJS/Sortable) 1.15.7（MIT）— 並べ替え。[`public/vendor/LICENSE`](public/vendor/LICENSE)
- [Tabler Icons](https://github.com/tabler/tabler-icons) 3.49.0（MIT）— 線画アイコン（使う分だけ）。[`public/icons/LICENSE`](public/icons/LICENSE)

## ライセンス

MIT — [LICENSE](LICENSE)
