export type StampCorner = "bottom-right" | "bottom-left" | "top-right" | "top-left";

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif|bmp|avif)$/i;

export function isImageName(name: string): boolean {
  return IMAGE_EXT.test(name);
}

export function outputMime(file: File): string {
  const name = file.name.toLowerCase();
  if (file.type === "image/png" || name.endsWith(".png")) return "image/png";
  if (file.type === "image/webp" || name.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

export function outputRelativePath(relativePath: string, mime: string): string {
  const slash = relativePath.lastIndexOf("/");
  const dir = slash >= 0 ? relativePath.slice(0, slash + 1) : "";
  const fileName = slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
  const dot = fileName.lastIndexOf(".");
  const base = dot >= 0 ? fileName.slice(0, dot) : fileName;
  const ext = mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : ".jpg";
  return `${dir}${base}${ext}`;
}

async function decodeHeic(file: File): Promise<Blob> {
  const mod = await import("heic2any");
  const convert = mod.default;
  const converted = await convert({ blob: file, toType: "image/jpeg", quality: 0.95 });
  return Array.isArray(converted) ? converted[0] : converted;
}

export async function decodeImage(file: File): Promise<ImageBitmap> {
  const heic = /\.heic$|\.heif$/i.test(file.name) || file.type === "image/heic" || file.type === "image/heif";
  if (!heic) {
    return createImageBitmap(file, { imageOrientation: "from-image" });
  }
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    const jpeg = await decodeHeic(file);
    return createImageBitmap(jpeg);
  }
}

export function drawStamp(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  text: string,
  corner: StampCorner,
): void {
  const fontSize = Math.max(28, Math.round(Math.min(width, height) * 0.055));
  const pad = Math.round(fontSize * 0.42);
  const margin = Math.round(fontSize * 0.5);
  const right = corner.endsWith("right");
  const bottom = corner.startsWith("bottom");

  ctx.save();
  ctx.font = `700 ${fontSize}px "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif`;
  const textWidth = ctx.measureText(text).width;
  const boxWidth = Math.ceil(textWidth + pad * 2);
  const boxHeight = Math.ceil(fontSize + pad * 2);
  const x = right ? width - margin - boxWidth : margin;
  const y = bottom ? height - margin - boxHeight : margin;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, boxWidth, boxHeight);
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = Math.max(3, fontSize * 0.07);
  ctx.strokeRect(x, y, boxWidth, boxHeight);
  ctx.fillStyle = "#000000";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + pad, y + boxHeight / 2);
  ctx.restore();
}

export async function canvasToBlob(canvas: HTMLCanvasElement, mime: string): Promise<Blob> {
  const encode = (type: string) =>
    new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), type, 0.92);
    });

  const blob = (await encode(mime)) ?? (mime === "image/jpeg" ? null : await encode("image/jpeg"));
  if (!blob) throw new Error("encode");
  return blob;
}

export async function stampFile(
  file: File,
  text: string,
  corner: StampCorner,
  maxEdge?: number,
): Promise<Blob> {
  const bitmap = await decodeImage(file);
  try {
    let width = bitmap.width;
    let height = bitmap.height;
    if (maxEdge && Math.max(width, height) > maxEdge) {
      const scale = maxEdge / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    const mime = outputMime(file);
    if (mime === "image/jpeg") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    drawStamp(ctx, width, height, text, corner);
    return canvasToBlob(canvas, mime);
  } finally {
    bitmap.close();
  }
}

export async function makeSamplePreview(corner: StampCorner, withTime: boolean): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 640;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");

  const sky = ctx.createLinearGradient(0, 0, 0, canvas.height);
  sky.addColorStop(0, "#8eb6d8");
  sky.addColorStop(0.55, "#e7d7b8");
  sky.addColorStop(1, "#6d8a62");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "#f4e2b0";
  ctx.beginPath();
  ctx.arc(760, 150, 58, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#35543a";
  ctx.beginPath();
  ctx.moveTo(0, 470);
  ctx.lineTo(180, 360);
  ctx.lineTo(340, 450);
  ctx.lineTo(520, 300);
  ctx.lineTo(760, 430);
  ctx.lineTo(960, 340);
  ctx.lineTo(960, 640);
  ctx.lineTo(0, 640);
  ctx.fill();

  const text = withTime ? "2024/04/12 15:30" : "2024/04/12";
  drawStamp(ctx, canvas.width, canvas.height, text, corner);
  const blob = await canvasToBlob(canvas, "image/jpeg");
  return URL.createObjectURL(blob);
}
