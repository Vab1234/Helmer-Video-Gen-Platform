import axios from "axios";
import fs from "fs";
import path from "path";
import { MIN_BYTES } from "../config/constants";
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
    // If HEAD fails, we'll try to GET anyway but return defaults
    return { ok: true, contentType: "", contentLength: undefined };
  }
}

function inferExtension(contentType: string, fallback: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("image")) {
    if (ct.includes("png")) return ".png";
    if (ct.includes("webp")) return ".webp";
    return ".jpg";
  }
  if (ct.includes("video")) {
    if (ct.includes("mp4")) return ".mp4";
    if (ct.includes("webm")) return ".webm";
    return ".mp4";
  }
  if (ct.includes("audio")) {
    if (ct.includes("wav")) return ".wav";
    if (ct.includes("ogg")) return ".ogg";
    return ".mp3";
  }
  return fallback;
}

export async function downloadToDir(
  url: string,
  toDir: string,
  preferredExt: string,
  source: string = "unknown" // Added source parameter
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
    // This is the error you were seeing. It triggers when a link is a tiny pixel.
    throw new Error(`Asset from ${source} is too small or invalid (HEAD)`);
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
    throw new Error(`Asset from ${source} is below MIN_BYTES limit`);
  }

  const hash = sha256Bytes(content);
  const ext = inferExtension(contentType, preferredExt);

  await fsp.mkdir(toDir, { recursive: true });

  // --- NEW NAMING LOGIC ---
  // Clean source name (e.g., "Pexels Images" -> "pexels")
  const cleanSource = source.toLowerCase().split(' ')[0]; 
  const fileName = `${cleanSource}_${hash.slice(0, 12)}${ext}`;
  const filePath = path.join(toDir, fileName);

  if (!fs.existsSync(filePath)) {
    await fsp.writeFile(filePath, content);
  }

  const width = 0;
  const height = 0;

  return { filePath, content, contentType, width, height, hash };
}