import { useEffect, useRef, useState } from "react";
import { formatStamp, readCaptureDate, stampedFolderName } from "./lib/dates";
import {
  albumFromFileList,
  albumsFromDataTransfer,
  canPickDirectory,
  collectFromDirectoryHandle,
  createOutputDirectory,
  ensureWritePermission,
  writeBlobFile,
  type AlbumDraft,
} from "./lib/folders";
import { makeSamplePreview, outputRelativePath, stampFile, type StampCorner } from "./lib/images";
import { downloadBlob, zipAlbum } from "./lib/save";

type Phase = "empty" | "loading" | "ready" | "running" | "done";

type ResultState = {
  saved: { label: string; count: number; where: "folder" | "zip" }[];
  fileDates: number;
  failures: string[];
  cancelled: boolean;
  fellBackToZip: boolean;
  downloads: { url: string; name: string }[];
};

const CORNERS: { id: StampCorner; label: string }[] = [
  { id: "bottom-left", label: "左下" },
  { id: "bottom-right", label: "右下" },
  { id: "top-left", label: "左上" },
  { id: "top-right", label: "右上" },
];

function photoCount(albums: AlbumDraft[]): number {
  return albums.reduce((sum, album) => sum + album.images.length, 0);
}

export default function App() {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(false);
  const [albums, setAlbums] = useState<AlbumDraft[]>([]);
  const [phase, setPhase] = useState<Phase>("empty");
  const [dragging, setDragging] = useState(false);
  const [corner, setCorner] = useState<StampCorner>("bottom-right");
  const [withTime, setWithTime] = useState(true);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState({ current: 0, total: 0, name: "" });
  const [result, setResult] = useState<ResultState | null>(null);
  const [preview, setPreview] = useState<{ url: string; sample: boolean; fileDate: boolean } | null>(null);

  const canWriteHere = albums.length > 0 && albums.every((album) => album.handle) && canPickDirectory();
  const canChooseSaveFolder = albums.length === 1 && !albums[0].handle && canPickDirectory();

  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");
  }, []);

  const dropRef = useRef<(event: DragEvent) => void>(() => {});
  dropRef.current = (event) => {
    void onDrop(event);
  };

  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer?.types.includes("Files")) setDragging(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget == null) setDragging(false);
    };
    const onWindowDrop = (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      dropRef.current(event);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onWindowDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onWindowDrop);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const first = albums[0]?.images[0];

    (async () => {
      try {
        if (!first) {
          const url = await makeSamplePreview(corner, withTime);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          setPreview((current) => {
            if (current) URL.revokeObjectURL(current.url);
            return { url, sample: true, fileDate: false };
          });
          return;
        }

        const captured = await readCaptureDate(first.file);
        const blob = await stampFile(first.file, formatStamp(captured.date, withTime), corner, 1600);
        const url = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        setPreview((current) => {
          if (current) URL.revokeObjectURL(current.url);
          return { url, sample: false, fileDate: captured.source === "file" };
        });
      } catch {
        if (!cancelled) {
          setPreview((current) => (current?.sample ? current : null));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [albums, corner, withTime]);

  function clearResult() {
    setResult((current) => {
      current?.downloads.forEach((item) => URL.revokeObjectURL(item.url));
      return null;
    });
  }

  function reset() {
    clearResult();
    setAlbums([]);
    setPhase("empty");
    setError("");
    setProgress({ current: 0, total: 0, name: "" });
  }

  async function useAlbums(next: AlbumDraft[]) {
    clearResult();
    if (next.length === 0 || photoCount(next) === 0) {
      setAlbums([]);
      setPhase("empty");
      setError("対応する写真が見つかりませんでした。JPEG、PNG、WEBP、HEICを入れられます。");
      return;
    }
    setError("");
    setAlbums(next);
    setPhase("ready");
  }

  async function onDrop(event: DragEvent) {
    if (phase === "running" || phase === "loading") return;
    const items = event.dataTransfer?.items;
    if (!items) return;
    setPhase("loading");
    setError("");
    try {
      await useAlbums(await albumsFromDataTransfer(items));
    } catch {
      setPhase("empty");
      setError("フォルダを読めませんでした。");
    }
  }

  async function onChooseFolder() {
    if (phase === "running" || phase === "loading") return;
    setError("");
    if (!window.showDirectoryPicker) {
      folderInputRef.current?.click();
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      setPhase("loading");
      const images = await collectFromDirectoryHandle(handle);
      await useAlbums([
        {
          id: crypto.randomUUID(),
          folderName: handle.name,
          handle,
          images,
        },
      ]);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setPhase(albums.length > 0 ? "ready" : "empty");
      setError("フォルダを開けませんでした。");
    }
  }

  async function onFolderInput(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (selected.length === 0) return;
    setPhase("loading");
    const album = albumFromFileList(selected);
    await useAlbums(album ? [album] : []);
  }

  async function onFileInput(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (selected.length === 0) return;
    setPhase("loading");
    const album = albumFromFileList(selected);
    await useAlbums(album ? [album] : []);
  }

  async function processAlbums(list: AlbumDraft[], asZip: boolean) {
    cancelRef.current = false;
    clearResult();
    setError("");
    setPhase("running");
    const totalCount = photoCount(list);
    let current = 0;
    let fileDates = 0;
    let fellBackToZip = false;
    const failures: string[] = [];
    const saved: ResultState["saved"] = [];
    const downloads: ResultState["downloads"] = [];

    for (const album of list) {
      if (cancelRef.current) break;
      const outputName = stampedFolderName(album.folderName);
      const zipFiles: { relativePath: string; blob: Blob }[] = [];
      let output: FileSystemDirectoryHandle | null = null;
      let folderWrote = 0;
      const wantedFolder = !asZip && Boolean(album.handle);
      let canWrite = false;

      if (wantedFolder && album.handle) {
        canWrite = await ensureWritePermission(album.handle);
        if (!canWrite) fellBackToZip = true;
      }

      for (const image of album.images) {
        if (cancelRef.current) break;
        current += 1;
        setProgress({ current, total: totalCount, name: image.relativePath });
        try {
          const captured = await readCaptureDate(image.file);
          if (captured.source === "file") fileDates += 1;
          const blob = await stampFile(image.file, formatStamp(captured.date, withTime), corner);
          const relativePath = outputRelativePath(image.relativePath, blob.type);
          let stored = false;
          if (canWrite && album.handle) {
            try {
              if (!output) {
                const created = await createOutputDirectory(album.handle, album.folderName);
                output = created.output;
              }
              await writeBlobFile(output, relativePath, blob);
              folderWrote += 1;
              stored = true;
            } catch {
              canWrite = false;
              fellBackToZip = true;
            }
          }
          if (!stored) zipFiles.push({ relativePath, blob });
        } catch {
          failures.push(image.relativePath);
        }
      }

      if (folderWrote > 0) {
        saved.push({
          label: `${album.folderName} / ${outputName}`,
          count: folderWrote,
          where: "folder",
        });
      }
      if (zipFiles.length === 0) continue;

      const zipped = await zipAlbum(album.folderName, zipFiles);
      const url = URL.createObjectURL(zipped.blob);
      downloads.push({ url, name: zipped.name });
      downloadBlob(zipped.blob, zipped.name);
      saved.push({ label: zipped.name, count: zipFiles.length, where: "zip" });
    }

    setResult({
      saved,
      fileDates,
      failures,
      cancelled: cancelRef.current,
      fellBackToZip,
      downloads,
    });
    setPhase("done");
  }

  async function onSave() {
    if (phase === "running" || albums.length === 0) return;
    let list = albums;
    if (canChooseSaveFolder) {
      try {
        const handle = await window.showDirectoryPicker?.({ mode: "readwrite" });
        if (!handle) return;
        list = [{ ...albums[0], handle, folderName: handle.name }];
        setAlbums(list);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError("フォルダを選べませんでした。ZIPでも保存できます。");
        return;
      }
    }
    await processAlbums(list, false);
  }

  const busy = phase === "loading" || phase === "running";
  const percent = progress.total === 0 ? 0 : Math.round((progress.current / progress.total) * 100);

  return (
    <main className="page">
      <header className="hero">
        <p className="eyebrow">写真はこの端末の中だけで処理されます</p>
        <h1>写真に日時を焼き込む</h1>
        <p className="lede">
          写真の入ったフォルダをドロップすると、1枚ずつの撮影日時を画像の中へ表示します。元のフォルダの中に、フォルダ名の後ろへ「タイムスタンプ済み」を付けた新しいフォルダを作り、そこへ保存します。
        </p>
      </header>

      <section
        className={dragging ? "drop over" : "drop"}
        onClick={() => {
          if (!busy) void onChooseFolder();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || busy) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void onChooseFolder();
          }
        }}
        tabIndex={0}
        aria-label="写真フォルダをドロップするか、選ぶ"
      >
        <FolderMark />
        <div>
          <h2>{phase === "loading" ? "フォルダを読んでいます" : "フォルダをここにドロップ"}</h2>
          <p>JPEG、PNG、WEBP、HEIC。フォルダの中のサブフォルダも、そのままの形で保存します。</p>
        </div>
        <div className="drop-actions">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              void onChooseFolder();
            }}
          >
            フォルダを選ぶ
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              fileInputRef.current?.click();
            }}
          >
            写真ファイルだけ選ぶ
          </button>
        </div>
      </section>

      <input ref={folderInputRef} className="hidden-input" type="file" multiple onChange={(event) => void onFolderInput(event)} />
      <input
        ref={fileInputRef}
        className="hidden-input"
        type="file"
        accept="image/*"
        multiple
        onChange={(event) => void onFileInput(event)}
      />

      <section className="sheet">
        <div className="options">
          <fieldset>
            <legend>表示</legend>
            <div className="segmented" role="group" aria-label="日時の表示">
              <button type="button" aria-pressed={withTime} disabled={busy} onClick={() => setWithTime(true)}>
                日時
              </button>
              <button type="button" aria-pressed={!withTime} disabled={busy} onClick={() => setWithTime(false)}>
                日付だけ
              </button>
            </div>
          </fieldset>
          <fieldset>
            <legend>位置</legend>
            <div className="segmented" role="group" aria-label="表示位置">
              {CORNERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={corner === item.id}
                  disabled={busy}
                  onClick={() => setCorner(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        <figure className="preview">
          {preview ? <img src={preview.url} alt={preview.sample ? "日時を入れた見本" : "1枚目の仕上がりプレビュー"} /> : <div className="preview-empty">プレビューを準備しています</div>}
          <figcaption>
            {preview?.sample
              ? "見本です。フォルダを入れると、1枚目の仕上がりに替わります。"
              : "1枚目のプレビューです。この位置と表示を、すべての写真に使います。"}
            {preview?.fileDate ? " この写真には撮影日時がなかったので、ファイルの更新日時を表示しています。" : ""}
          </figcaption>
        </figure>

        {albums.length > 0 && phase !== "done" && (
          <div className="plan">
            {albums.map((album) => (
              <p key={album.id}>
                <strong>{album.folderName}</strong>
                <span>{album.images.length}枚</span>
                <span className="arrow">→</span>
                {album.handle ? (
                  <span>
                    {album.folderName} / {stampedFolderName(album.folderName)}
                  </span>
                ) : canPickDirectory() ? (
                  <span>選んだフォルダの中の「フォルダ名タイムスタンプ済み」</span>
                ) : (
                  <span>{stampedFolderName(album.folderName)}.zip</span>
                )}
              </p>
            ))}
            <p className="note">元の写真は変更しません。同じ名前がすでにある場合は、その写真だけ上書きします。</p>
          </div>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {phase === "running" && (
          <div className="progress" aria-live="polite">
            <div className="bar">
              <span style={{ width: `${percent}%` }} />
            </div>
            <p>
              {progress.current} / {progress.total}枚
              {progress.name ? `　${progress.name}` : ""}
            </p>
            <button type="button" className="ghost" onClick={() => (cancelRef.current = true)}>
              中断する
            </button>
          </div>
        )}

        {phase === "done" && result && (
          <div className="result" role="status">
            <h2>{result.cancelled ? "ここまで保存しました" : result.saved.length > 0 ? "保存しました" : "保存できた写真がありません"}</h2>
            {result.saved.map((item) => (
              <p key={item.label}>
                {item.count}枚を {item.label} {item.where === "folder" ? "に保存しました" : "としてダウンロードしました"}
              </p>
            ))}
            {result.saved.some((item) => item.where === "folder") && (
              <p className="note">新しいフォルダは、選んだフォルダの中にできています。</p>
            )}
            {result.fellBackToZip && <p className="note">フォルダへの書き込みが許可されなかったため、ZIPでダウンロードしました。</p>}
            {result.fileDates > 0 && (
              <p className="note">撮影日時がなかった{result.fileDates}枚は、ファイルの更新日時を入れました。</p>
            )}
            {result.failures.length > 0 && (
              <div className="failures">
                <p>処理できなかった写真が{result.failures.length}枚あります。</p>
                <ul>
                  {result.failures.slice(0, 6).map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </div>
            )}
            {result.downloads.map((item) => (
              <a key={item.name} className="download" href={item.url} download={item.name}>
                {item.name} を再ダウンロード
              </a>
            ))}
          </div>
        )}

        {phase !== "running" && albums.length > 0 && (
          <div className="actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void onSave()}>
              {canWriteHere ? "同じフォルダの中に保存" : canChooseSaveFolder ? "保存先フォルダを選んで保存" : "ZIPでダウンロード"}
            </button>
            {(canWriteHere || canChooseSaveFolder) && (
              <button type="button" className="ghost" disabled={busy} onClick={() => void processAlbums(albums, true)}>
                ZIPでダウンロード
              </button>
            )}
            <button type="button" className="ghost" onClick={reset}>
              最初から
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

function FolderMark() {
  return (
    <svg className="folder-mark" viewBox="0 0 64 64" aria-hidden="true">
      <path d="M8 18.5h18l4 5H56v24.5a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4V18.5Z" fill="#f4efe4" stroke="#1c1915" strokeWidth="2.4" />
      <path d="M8 24h48" stroke="#1c1915" strokeWidth="2.4" />
      <text x="32" y="42" textAnchor="middle" fontSize="9" fontWeight="700" fill="#1c1915">
        10/08
      </text>
    </svg>
  );
}
