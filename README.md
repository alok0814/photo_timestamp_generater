# 写真に日時を焼き込む

写真の入ったフォルダをドロップすると、1枚ごとの撮影日時を画像の中へ表示し、同じフォルダの中に新しいフォルダを作って保存します。

例: `旅行` を入れると、`旅行/旅行タイムスタンプ済み/` ができます。元の写真は変更しません。

処理はブラウザの中だけで完結します。写真はサーバーへ送られません。

## 使い方

1. `npm install`
2. `npm run dev`
3. 開いたページへ、写真の入ったフォルダをドロップする
4. 位置と「日時 / 日付だけ」を確認する
5. 「同じフォルダの中に保存」を押す

Chrome と Edge では、選んだフォルダの中へ直接書き込みます。Safari と Firefox にはフォルダへ書く機能がないため、`フォルダ名タイムスタンプ済み.zip` をダウンロードします。解凍すると同じ形のフォルダになります。

撮影日時は写真の Exif（DateTimeOriginal、なければ CreateDate、ModifyDate）から読みます。Exif がない写真は、ファイルの更新日時を使います。

対応形式は JPEG、PNG、WEBP、GIF、AVIF、HEIC です。HEIC を開けない場合は、JPEG で書き出してから入れてください。

もう一度実行すると、タイムスタンプ済みフォルダの中の同じ名前だけを上書きします。

## 公開

ビルドすると静的ファイルになります。

```bash
npm run build
```

出力は `dist` です。Vercel では Framework Preset を Vite、Build Command を `npm run build`、Output Directory を `dist` にしてください。設定は `vercel.json` にも書いてあります。

```bash
npx vercel
```

Cloudflare Pages など、静的ファイルを配信できる場所でも同じように公開できます。
