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
import { batchFiles, canSharePhotos, isPhone, toPhotoFile } from "./lib/camera";
import { downloadBlob, zipAlbum } from "./lib/save";

type Phase = "empty" | "loading" | "ready" | "running" | "done";

type ResultState = {
  saved: { label: string; count: number; where: "folder" | "zip" | "camera" }[];
  fileDates: number;
  failures: string[];
  cancelled: boolean;
  fellBackToZip: boolean;
  downloads: { url: string; name: string }[];
  cameraBatches: File[][];
  sharedBatches: number;
  handSave: { url: string; name: string }[];
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
      current?.handSave.forEach((item) => URL.revokeObjectURL(item.url));
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

  async function processAlbums(list: AlbumDraft[], mode: "folder" | "zip" | "camera") {
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
    const cameraFiles: File[] = [];
    const usedNames = new Set<string>();

    for (const album of list) {
      if (cancelRef.current) break;
      const outputName = stampedFolderName(album.folderName);
      const zipFiles: { relativePath: string; blob: Blob }[] = [];
      let output: FileSystemDirectoryHandle | null = null;
      let folderWrote = 0;
      const wantedFolder = mode === "folder" && Boolean(album.handle);
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
          if (mode === "camera") {
            cameraFiles.push(toPhotoFile(relativePath, blob, usedNames));
            continue;
          }
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

    const cameraBatches = mode === "camera" && canSharePhotos(cameraFiles) ? batchFiles(cameraFiles) : [];
    const handSave =
      mode === "camera" && cameraBatches.length === 0
        ? cameraFiles.map((file) => ({ url: URL.createObjectURL(file), name: file.name }))
        : [];
    if (cameraFiles.length > 0) {
      saved.push({ label: "カメラロール", count: cameraFiles.length, where: "camera" });
    }

    setResult({
      saved,
      fileDates,
      failures,
      cancelled: cancelRef.current,
      fellBackToZip,
      downloads,
      cameraBatches,
      sharedBatches: 0,
      handSave,
    });
    setPhase("done");
  }

  async function shareNextBatch() {
    const batches = result?.cameraBatches ?? [];
    const index = result?.sharedBatches ?? 0;
    const files = batches[index];
    if (!files) return;
    try {
      await navigator.share({ files });
      setResult((current) => (current ? { ...current, sharedBatches: current.sharedBatches + 1 } : current));
      setError("");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      if (files.length > 1) {
        const middle = Math.ceil(files.length / 2);
        setResult((current) => {
          if (!current) return current;
          const next = [...current.cameraBatches];
          next.splice(index, 1, files.slice(0, middle), files.slice(middle));
          return { ...current, cameraBatches: next };
        });
        setError("一度に保存できなかったので、枚数を分けました。もう一度押してください。");
        return;
      }
      setError("カメラロールに保存できませんでした。もう一度押してください。");
    }
  }

  async function onSave() {
    if (phase === "running" || albums.length === 0) return;
    if (isPhone()) {
      await processAlbums(albums, "camera");
      return;
    }
    let list = albums;
    if (canChooseSaveFolder) {
      try {
        const handle = await window.showDirectoryPicker?.({ mode: "readwrite" });
        if (!handle) return;
        list = [{ ...albums[0], handle, folderName: handle.name }];
        setAlbums(list);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError("フォルダを選べませんでした。ダウンロードでも保存できます。");
        return;
      }
    }
    await processAlbums(list, "folder");
  }

  const phone = isPhone();
  const busy = phase === "loading" || phase === "running";
  const percent = progress.total === 0 ? 0 : Math.round((progress.current / progress.total) * 100);

  return (
    <main className="page">
      <header className="hero">
        <h1>写真に日付を入れます</h1>
        <p className="lede">上から順に、大きいボタンを押してください。</p>
      </header>

      <section className={dragging ? "step drop over" : "step"} aria-label="手順1 写真を選ぶ">
        <h2>
          <span>1</span>写真を選ぶ
        </h2>
        <p>
          {phase === "loading"
            ? "写真を読んでいます。そのままお待ちください。"
            : phone
              ? "カメラロールから、日付を入れたい写真を選んでください。"
              : "日付を入れたい写真のフォルダを選んでください。"}
        </p>
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => {
              if (phone) fileInputRef.current?.click();
              else void onChooseFolder();
            }}
          >
            {phone ? "カメラロールから選ぶ" : "フォルダを選ぶ"}
          </button>
          {!phone && (
            <button type="button" className="ghost" disabled={busy} onClick={() => fileInputRef.current?.click()}>
              写真を選ぶ
            </button>
          )}
        </div>
        <p className="note">{phone ? "何枚でも選べます。" : "フォルダを、この枠の中へ持ってきても選べます。"}</p>
      </section>

      <input ref={folderInputRef} className="hidden-input" type="file" multiple aria-hidden="true" tabIndex={-1} onChange={(event) => void onFolderInput(event)} />
      <input
        ref={fileInputRef}
        className="hidden-input"
        type="file"
        accept="image/*"
        multiple
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => void onFileInput(event)}
      />

      <section className="step" aria-label="手順2 日付の入れ方">
        <h2>
          <span>2</span>日付の入れ方を選ぶ
        </h2>
        <div className="options">
          <fieldset>
            <legend>文字</legend>
            <div className="segmented" role="group" aria-label="日時の表示">
              <button type="button" aria-pressed={withTime} disabled={busy} onClick={() => setWithTime(true)}>
                {withTime ? "✓ 日付と時間" : "日付と時間"}
              </button>
              <button type="button" aria-pressed={!withTime} disabled={busy} onClick={() => setWithTime(false)}>
                {!withTime ? "✓ 日付だけ" : "日付だけ"}
              </button>
            </div>
          </fieldset>
          <fieldset>
            <legend>場所</legend>
            <div className="segmented" role="group" aria-label="表示位置">
              {CORNERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={corner === item.id}
                  disabled={busy}
                  onClick={() => setCorner(item.id)}
                >
                  {corner === item.id ? `✓ ${item.label}` : item.label}
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        <figure className="preview">
          {preview ? <img src={preview.url} alt={preview.sample ? "日付を入れた見本" : "1枚目の仕上がり"} /> : <div className="preview-empty">見本を準備しています</div>}
          <figcaption>
            {preview?.sample ? "これは見本です。写真を選ぶと、1枚目の仕上がりに替わります。" : "これが1枚目の仕上がりです。全部の写真が、この入れ方になります。"}
            {preview?.fileDate ? " この写真には撮影した日時がなかったので、ファイルの日時を使います。" : ""}
          </figcaption>
        </figure>
      </section>

      <section className="step" aria-label="手順3 保存する">
        <h2>
          <span>3</span>保存する
        </h2>
        {albums.length === 0 ? (
          <p>{phone ? "先に、上の「カメラロールから選ぶ」を押してください。" : "先に、上の「フォルダを選ぶ」を押してください。"}</p>
        ) : (
          <div className="plan">
            {albums.map((album) => (
              <p key={album.id}>
                <strong>{album.folderName}</strong>
                <span>{album.images.length}枚</span>
              </p>
            ))}
            <p>
              {phone
                ? "元の写真はそのまま残ります。日付を入れた写真を、カメラロールに保存します。"
                : "元の写真はそのまま残ります。日付を入れた写真は、新しいフォルダに入ります。"}
            </p>
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
              {progress.current}枚目を処理しています。全部で{progress.total}枚です。
              {progress.name ? ` ${progress.name}` : ""}
            </p>
            <button type="button" className="ghost" onClick={() => (cancelRef.current = true)}>
              中断する
            </button>
          </div>
        )}

        {phase === "done" && result && (
          <div className="result" role="status">
            <h3>
              {result.cancelled
                ? "ここまでできました"
                : result.cameraBatches.length > result.sharedBatches || result.handSave.length > 0
                  ? "日付を入れました"
                  : result.saved.length > 0
                    ? "保存できました"
                    : "保存できた写真がありません"}
            </h3>
            {result.saved.map((item) => (
              <p key={item.label}>
                {item.where === "folder"
                  ? `${item.count}枚を ${item.label} に保存しました`
                  : item.where === "camera"
                    ? `${item.count}枚に日付を入れました`
                    : `${item.count}枚を ${item.label} としてダウンロードしました`}
              </p>
            ))}
            {result.saved.some((item) => item.where === "folder") && <p>新しいフォルダは、選んだフォルダの中にできています。</p>}
            {result.fellBackToZip && <p>フォルダに保存できなかったので、ダウンロードしました。</p>}
            {result.fileDates > 0 && <p>撮影した日時がなかった{result.fileDates}枚は、ファイルの日時を入れました。</p>}
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
            {result.cameraBatches.length > result.sharedBatches && (
              <>
                <p>下のボタンを押してください。出てきた画面で「画像を保存」を選ぶと、カメラロールに入ります。</p>
                <button type="button" className="primary" onClick={() => void shareNextBatch()}>
                  {result.cameraBatches.length === 1
                    ? "カメラロールに保存"
                    : `カメラロールに保存（${result.cameraBatches.slice(0, result.sharedBatches).reduce((sum, batch) => sum + batch.length, 0) + 1}〜${result.cameraBatches.slice(0, result.sharedBatches).reduce((sum, batch) => sum + batch.length, 0) + result.cameraBatches[result.sharedBatches].length}枚目）`}
                </button>
              </>
            )}
            {result.cameraBatches.length > 0 && result.sharedBatches >= result.cameraBatches.length && <p>カメラロールに保存しました。</p>}
            {result.handSave.length > 0 && (
              <div className="hand-save">
                <p>写真を長く押して、「画像を保存」を選んでください。カメラロールに入ります。</p>
                {result.handSave.map((item) => (
                  <img key={item.url} src={item.url} alt={item.name} />
                ))}
              </div>
            )}
            {result.downloads.map((item) => (
              <a key={item.name} className="download" href={item.url} download={item.name}>
                もう一度ダウンロードする
              </a>
            ))}
          </div>
        )}

        {phase !== "running" && !(result && result.cameraBatches.length > result.sharedBatches) && (
          <div className="actions">
            <button type="button" className="primary" disabled={busy || albums.length === 0} onClick={() => void onSave()}>
              {phone ? "カメラロールに保存" : canWriteHere || canChooseSaveFolder || albums.length === 0 ? "保存する" : "ダウンロードする"}
            </button>
            {!phone && albums.length > 0 && (canWriteHere || canChooseSaveFolder) && (
              <button type="button" className="ghost" disabled={busy} onClick={() => void processAlbums(albums, "zip")}>
                ダウンロードする
              </button>
            )}
            {albums.length > 0 && (
              <button type="button" className="ghost" onClick={reset}>
                最初からやり直す
              </button>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
