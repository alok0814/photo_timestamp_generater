const MAX_BATCH_COUNT = 8;
const MAX_BATCH_BYTES = 24 * 1024 * 1024;

export function isPhone(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return true;
  return /Android/i.test(ua);
}

export function toPhotoFile(relativePath: string, blob: Blob, used: Set<string>): File {
  const slash = relativePath.lastIndexOf("/");
  let name = slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
  if (!/\.(jpe?g|png|webp)$/i.test(name)) name = `${name}.jpg`;
  if (used.has(name)) {
    const dot = name.lastIndexOf(".");
    name = `${name.slice(0, dot)}-${used.size}${name.slice(dot)}`;
  }
  used.add(name);
  const type = blob.type || "image/jpeg";
  return new File([blob], name, { type, lastModified: Date.now() });
}

export function batchFiles(files: File[]): File[][] {
  const batches: File[][] = [];
  let batch: File[] = [];
  let bytes = 0;
  for (const file of files) {
    const full = batch.length > 0 && (batch.length >= MAX_BATCH_COUNT || bytes + file.size > MAX_BATCH_BYTES);
    if (full) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += file.size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export function canSharePhotos(files: File[]): boolean {
  if (typeof navigator === "undefined" || typeof navigator.canShare !== "function" || files.length === 0) return false;
  try {
    return navigator.canShare({ files: [files[0]] });
  } catch {
    return false;
  }
}
