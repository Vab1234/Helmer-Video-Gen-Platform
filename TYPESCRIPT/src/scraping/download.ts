// src/scraping/download.ts
import axios from "axios";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { MIN_BYTES, MIN_PIXELS } from "../config/constants";
import { sha256Bytes } from "../utils/hashing";

const fsp = fs.promises;

async function headOk(
  url: string
): Promise<{ ok: boolean; contentType: string; contentLength?: number }> {
  try {
    const res = await axios.head(url, {
      maxRedirects: 5,
      timeout: 8000,
    });
    const ct = res.headers["content-type"] ?? "";
    const clRaw = res.headers["content-length"];
    let cl: number | undefined = undefined;
    if (typeof clRaw === "string" && /^\d+$/.test(clRaw)) {
      cl = parseInt(clRaw, 10);
      if (cl < MIN_BYTES) {
        return { ok: false, contentType: ct, contentLength: cl };
      }
    }
    return { ok: true, contentType: ct, contentLength: cl };
  } catch {
    // If HEAD fails, let GET decide
    return { ok: true, contentType: "", contentLength: undefined };
  }
}

function inferExtension(contentType: string, fallback: string): string {
  if (contentType.includes("image")) {
    if (contentType.includes("png")) return ".png";
    if (contentType.includes("webp")) return ".webp";
    return ".jpg";
  }
  if (contentType.includes("video")) {
    if (contentType.includes("mp4")) return ".mp4";
    if (contentType.includes("webm")) return ".webm";
    return ".mp4";
  }
  if (contentType.includes("audio")) {
    if (contentType.includes("wav")) return ".wav";
    if (contentType.includes("ogg")) return ".ogg";
    return ".mp3";
  }
  return fallback;
}

export async function downloadToDir(
  url: string,
  toDir: string,
  preferredExt: string
): Promise<{
  filePath: string;
  content: Buffer;
  contentType: string;
  width: number;
  height: number;
  hash: string;
}> {
  if (url.startsWith("//")) {
    url = "https:" + url;
  }

  const head = await headOk(url);
  if (!head.ok) {
    throw new Error("Too small or invalid (HEAD)");
  }

  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30000,
    maxRedirects: 5,
  });

  const content = Buffer.from(res.data);
  const contentType =
    head.contentType || (res.headers["content-type"] as string) || "";

  if (content.length < MIN_BYTES) {
    throw new Error("Too small (bytes)");
  }

  const hash = sha256Bytes(content);
  const ext = inferExtension(contentType, preferredExt);

  await fsp.mkdir(toDir, { recursive: true });
  const fileName = `${hash.slice(0, 16)}${ext}`;
  const filePath = path.join(toDir, fileName);

  if (!fs.existsSync(filePath)) {
    await fsp.writeFile(filePath, content);
  }

  // image dims (for images)
  let width = 0;
  let height = 0;
  if (contentType.includes("image")) {
    try {
      const meta = await sharp(content).metadata();
      width = meta.width ?? 0;
      height = meta.height ?? 0;
      if (width * height < MIN_PIXELS) {
        await fsp.unlink(filePath);
        throw new Error("Image too small (pixels)");
      }
    } catch (err) {
      console.warn("[download] sharp metadata error:", err);
    }
  }

  return { filePath, content, contentType, width, height, hash };
}
