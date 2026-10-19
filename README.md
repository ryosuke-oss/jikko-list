# 実行リスト (jikko-list)

ブラウザの中だけで動く、自分専用のタスク管理アプリです。
A personal task list that runs entirely in the browser. All data stays on the device (IndexedDB).

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
- PC は3列、タブレットは2列、スマホは1列＋下のタブバー。どの幅でも横スクロールなし

## データとセキュリティ

- **データはこの端末のブラウザの中（IndexedDB）にだけ保存します。** サーバーへの送信、解析、広告、Cookie はありません
- 外部のファイル（CDN・Webフォント）を読み込みません。部品もアイコンも同じ場所から配信します
- `Content-Security-Policy`（`default-src 'none'`・`connect-src 'none'`）などのヘッダーで、外部との通信やページの埋め込みを止めています（[`public/_headers`](public/_headers)）
- 画面は `textContent` / `createElement` だけで組み立てます。`innerHTML` と `eval` は使いません
- リンクは `http://` と `https://` だけを保存し、`noopener noreferrer` で開きます
- 読み込むファイルは形式と版を確かめ、合わなければ1件も書き換えません。読み込みの直前の状態は自動で控えます
- サーバー側の処理や外から呼べる窓口（API）がない静的なサイトなので、呼び出し回数の制限（レート制限）は入れていません
- 例外は接続テスト用のページ [`/connect-test.html`](public/connect-test.html) だけです（同期の準備・試験用）。このページに限り、Google の `www.googleapis.com` と `sheets.googleapis.com` への通信を許可しています（`public/_headers` でこのページだけ CSP を差し替え）。ログインは Google の画面へ移動する方式（部品の読み込みなし）、権限は `drive.file`（このアプリが作ったファイルだけ）。送るのはテスト用の行だけで、アプリのタスクやメモは送りません。クライアントIDはコードに書かず、使う人が画面で貼ります

## 手元で動かす

```bash
python3 -m http.server 8787 --directory public
```

ブラウザで http://localhost:8787 を開きます（ファイルを直接開くと動きません）。

## テスト

```bash
npm test
```

Node.js 20 以上。1行の解釈・状態の連動・経験値の計算・期間の切り替え・読み込みの点検を確かめます。

## 公開

`main` に push すると、Cloudflare Workers Builds が [`wrangler.jsonc`](wrangler.jsonc) の設定で `public/` フォルダだけを公開します。

## 使っている部品

- [SortableJS](https://github.com/SortableJS/Sortable) 1.15.7（MIT）— 並べ替え。[`public/vendor/LICENSE`](public/vendor/LICENSE)
- [Tabler Icons](https://github.com/tabler/tabler-icons) 3.49.0（MIT）— 線画アイコン（使う分だけ）。[`public/icons/LICENSE`](public/icons/LICENSE)

## ライセンス

MIT — [LICENSE](LICENSE)
