import { STAMP_SUFFIX, stampedFolderName } from "./dates";
import { isImageName } from "./images";

export type ImageEntry = {
  relativePath: string;
  file: File;
};

export type AlbumDraft = {
  id: string;
  folderName: string;
  handle: FileSystemDirectoryHandle | null;
  images: ImageEntry[];
};

function skipName(name: string): boolean {
  return name.startsWith(".") || name.endsWith(STAMP_SUFFIX);
}

export async function collectFromDirectoryHandle(
  dir: FileSystemDirectoryHandle,
  prefix = "",
): Promise<ImageEntry[]> {
  const images: ImageEntry[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (skipName(name)) continue;
    if (handle.kind === "directory") {
      images.push(...(await collectFromDirectoryHandle(handle as FileSystemDirectoryHandle, `${prefix}${name}/`)));
      continue;
    }
    if (!isImageName(name)) continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    images.push({ relativePath: `${prefix}${name}`, file });
  }
  if (prefix === "") {
    images.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "ja", { numeric: true }));
  }
  return images;
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

async function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function collectFromDirectoryEntry(entry: FileSystemDirectoryEntry, prefix = ""): Promise<ImageEntry[]> {
  const reader = entry.createReader();
  const children = await readEntries(reader);
  const images: ImageEntry[] = [];
  for (const child of children) {
    if (skipName(child.name)) continue;
    if (child.isFile) {
      if (!isImageName(child.name)) continue;
      const file = await fileFromEntry(child as FileSystemFileEntry);
      images.push({ relativePath: `${prefix}${child.name}`, file });
      continue;
    }
    if (child.isDirectory) {
      images.push(...(await collectFromDirectoryEntry(child as FileSystemDirectoryEntry, `${prefix}${child.name}/`)));
    }
  }
  return images;
}

export async function albumsFromDataTransfer(items: DataTransferItemList): Promise<AlbumDraft[]> {
  const albums: AlbumDraft[] = [];
  const loose: ImageEntry[] = [];
  const pending = Array.from(items)
    .filter((item) => item.kind === "file")
    .map((item) => {
      const entry = item.webkitGetAsEntry?.() ?? null;
      return {
        handlePromise: item.getAsFileSystemHandle?.() ?? null,
        entry,
        file: entry?.isDirectory ? null : item.getAsFile(),
      };
    });

  for (const item of pending) {
    let handle: FileSystemHandle | null = null;
    try {
      handle = item.handlePromise ? await item.handlePromise : null;
    } catch {
      handle = null;
    }

    if (handle?.kind === "directory") {
      const directory = handle as FileSystemDirectoryHandle;
      albums.push({
        id: crypto.randomUUID(),
        folderName: directory.name,
        handle: directory,
        images: await collectFromDirectoryHandle(directory),
      });
      continue;
    }

    if (item.entry?.isDirectory) {
      albums.push({
        id: crypto.randomUUID(),
        folderName: item.entry.name,
        handle: null,
        images: await collectFromDirectoryEntry(item.entry as FileSystemDirectoryEntry),
      });
      continue;
    }

    if (item.file && isImageName(item.file.name)) {
      loose.push({ relativePath: item.file.name, file: item.file });
    }
  }

  if (loose.length > 0) {
    albums.push({
      id: crypto.randomUUID(),
      folderName: "写真",
      handle: null,
      images: loose,
    });
  }

  return albums
    .map(sortAlbum)
    .filter((album) => album.images.length > 0);
}

export function albumFromFileList(files: FileList | File[]): AlbumDraft | null {
  const images: ImageEntry[] = [];
  let folderName = "写真";

  for (const file of Array.from(files)) {
    const relative = file.webkitRelativePath || file.name;
    const parts = relative.split("/").filter(Boolean);
    if (parts.length > 1) folderName = parts[0];
    if (parts.some((part) => skipName(part))) continue;
    if (!isImageName(file.name)) continue;
    const relativePath = parts.length > 1 ? parts.slice(1).join("/") : file.name;
    images.push({ relativePath, file });
  }

  if (images.length === 0) return null;
  return sortAlbum({
    id: crypto.randomUUID(),
    folderName,
    handle: null,
    images,
  });
}

function sortAlbum(album: AlbumDraft): AlbumDraft {
  return {
    ...album,
    images: [...album.images].sort((a, b) => a.relativePath.localeCompare(b.relativePath, "ja", { numeric: true })),
  };
}

export async function ensureWritePermission(dir: FileSystemDirectoryHandle): Promise<boolean> {
  const descriptor = { mode: "readwrite" as const };
  try {
    if ((await dir.queryPermission?.(descriptor)) === "granted") return true;
    return (await dir.requestPermission?.(descriptor)) === "granted";
  } catch {
    return false;
  }
}

async function nestedDirectory(root: FileSystemDirectoryHandle, relativeDir: string): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const part of relativeDir.split("/").filter(Boolean)) {
    current = await current.getDirectoryHandle(part, { create: true });
  }
  return current;
}

export async function createOutputDirectory(
  dir: FileSystemDirectoryHandle,
  folderName: string,
): Promise<{ outputName: string; output: FileSystemDirectoryHandle }> {
  const outputName = stampedFolderName(folderName);
  const output = await dir.getDirectoryHandle(outputName, { create: true });
  return { outputName, output };
}

export async function writeBlobFile(
  output: FileSystemDirectoryHandle,
  relativePath: string,
  blob: Blob,
): Promise<void> {
  const slash = relativePath.lastIndexOf("/");
  const directory = slash >= 0 ? await nestedDirectory(output, relativePath.slice(0, slash)) : output;
  const name = slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

export function canPickDirectory(): boolean {
  return typeof window.showDirectoryPicker === "function";
}

export async function pickPhotoDirectory(): Promise<AlbumDraft | null> {
  if (!window.showDirectoryPicker) return null;
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  const images = await collectFromDirectoryHandle(handle);
  if (images.length === 0) {
    return sortAlbum({
      id: crypto.randomUUID(),
      folderName: handle.name,
      handle,
      images: [],
    });
  }
  return sortAlbum({
    id: crypto.randomUUID(),
    folderName: handle.name,
    handle,
    images,
  });
}
