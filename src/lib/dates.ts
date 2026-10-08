import exifr from "exifr";

export const STAMP_SUFFIX = "タイムスタンプ済み";

export function stampedFolderName(folderName: string): string {
  const base = folderName.trim() || "写真";
  if (base.endsWith(STAMP_SUFFIX)) return base;
  return `${base}${STAMP_SUFFIX}`;
}

function dateFromParts(year: number, month: number, day: number, hours = 0, minutes = 0, seconds = 0): Date | null {
  const date = new Date(year, month - 1, day, hours, minutes, seconds);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

/** Exifの日時文字列はタイムゾーンを持たないので、表示上の数字をずらさず読む。 */
export function parseExifString(value: string): Date | null {
  const match = value.match(/(\d{4})[:\-/](\d{2})[:\-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  return dateFromParts(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0),
  );
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string") return parseExifString(value);
  return null;
}

export async function readCaptureDate(file: File): Promise<{ date: Date; source: "exif" | "file" }> {
  try {
    const tags = await exifr.parse(file, {
      pick: ["DateTimeOriginal", "CreateDate", "ModifyDate"],
    });
    const fromExif = asDate(tags?.DateTimeOriginal) ?? asDate(tags?.CreateDate) ?? asDate(tags?.ModifyDate);
    if (fromExif) return { date: fromExif, source: "exif" };
  } catch {
    // 日付を持たない画像はそのままファイル日時へ落とす
  }
  return { date: new Date(file.lastModified || Date.now()), source: "file" };
}

export function formatStamp(date: Date, withTime: boolean): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const dateText = `${year}/${month}/${day}`;
  if (!withTime) return dateText;
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${dateText} ${hours}:${minutes}`;
}
