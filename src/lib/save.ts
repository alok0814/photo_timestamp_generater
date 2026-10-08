import JSZip from "jszip";
import { stampedFolderName } from "./dates";

export async function zipAlbum(
  folderName: string,
  files: { relativePath: string; blob: Blob }[],
): Promise<{ blob: Blob; name: string }> {
  const outputName = stampedFolderName(folderName);
  const zip = new JSZip();
  const root = zip.folder(outputName);
  if (!root) throw new Error("zip");
  for (const file of files) {
    root.file(file.relativePath, file.blob);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  return { blob, name: `${outputName}.zip` };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
