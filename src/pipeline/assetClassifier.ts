// src/pipeline/assetClassifier.ts

import fs from "fs";
import path from "path";
import util from "util";
import { exec } from "child_process";
import ffprobe from "ffprobe-static";
import ffmpeg from "ffmpeg-static";
import OpenAI from "openai";
import sizeOf from "image-size";
import * as mime from "mime-types";
import sharp from "sharp";
import { readJson, writeJson } from "../utils/fileUtils";
import { SEMANTIC_MAP_PATH } from "../config/constants";
import type { SemanticMap } from "../types/semanticMap";

const execAsync = util.promisify(exec);
const ColorThief = require('colorthief');
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ------------------------------------------------ */
/* ------------------ HELPERS --------------------- */
/* ------------------------------------------------ */

async function safeUnlink(filePath: string, retries = 5) {
  if (!filePath || !fs.existsSync(filePath)) return;

  for (let i = 0; i < retries; i++) {
    try {
      await fs.promises.unlink(filePath);
      return;
    } catch (err: any) {
      if (err.code === "EPERM" || err.code === "EBUSY") {
        await new Promise((res) => setTimeout(res, 200));
      } else {
        throw err;
      }
    }
  }
}

function parseRatio(w: number, h: number): string {
  const r = w / h;
  if (Math.abs(r - 1) < 0.05) return "1:1";
  if (Math.abs(r - 16 / 9) < 0.05) return "16:9";
  if (Math.abs(r - 9 / 16) < 0.05) return "9:16";
  if (Math.abs(r - 4 / 3) < 0.05) return "4:3";
  return `${w}:${h}`;
}

function getOrientation(w: number, h: number) {
  if (!w || !h) return "unknown";
  if (w > h) return "landscape";
  if (h > w) return "portrait";
  return "square";
}

/* ------------------------------------------------ */
/* ----------- TECHNICAL PROBE (Layer 1) --------- */
/* ------------------------------------------------ */

async function probe(file: string) {
  if (!ffprobe?.path) return null;

  try {
    const stats = await fs.promises.stat(file);
    if (stats.size === 0) return null;

    try {
      const cmd = `"${ffprobe.path}" -v error -print_format json -show_streams -show_format "${file}"`;
      const { stdout } = await execAsync(cmd);
      const meta = JSON.parse(stdout);

      const stream = meta.streams?.find((s: any) => s.width && s.height);
      if (!stream) throw new Error("No valid stream");

      const width = Number(stream.width);
      const height = Number(stream.height);
      const formatName = (meta.format?.format_name || "").toLowerCase();
      const isImage =
        formatName.includes("image") ||
        formatName.includes("png") ||
        formatName.includes("webp") ||
        stream.codec_name === "mjpeg";

      return {
        width,
        height,
        type: isImage ? "image" : "video",
        orientation: getOrientation(width, height),
        aspect_ratio: parseRatio(width, height),
        duration: isImage
          ? 0
          : meta.format?.duration
          ? parseFloat(meta.format.duration)
          : 0,
        codec: stream.codec_name,
        file_size_mb: +(stats.size / 1024 / 1024).toFixed(2),
      };
    } catch {
      const ext = path.extname(file).toLowerCase();
      const imageExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"];

      if (imageExtensions.includes(ext)) {
        const buffer = fs.readFileSync(file);
        const dimensions = sizeOf(buffer);

        return {
          width: dimensions.width!,
          height: dimensions.height!,
          type: "image",
          orientation: getOrientation(dimensions.width!, dimensions.height!),
          aspect_ratio: parseRatio(dimensions.width!, dimensions.height!),
          duration: 0,
          codec: dimensions.type || ext.replace(".", ""),
          file_size_mb: 0,
        };
      }
      return null;
    }
  } catch {
    return null;
  }
}

/* ------------------------------------------------ */
/* ----------- OPENAI VISION SEMANTICS ----------- */
/* ------------------------------------------------ */

async function getOpenAIVisualSemantics(filePath: string) {
  try {
    // 1. Read and "Normalize" the image using Sharp
    // This fixes encoding issues and strips metadata that might cause errors
    const processedImageBuffer = await sharp(filePath)
      .jpeg({ quality: 80 }) // Force it to a standard JPEG
      .toBuffer();

    const base64Image = processedImageBuffer.toString("base64");
    const mimeType = "image/jpeg"; 

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze this image and return JSON..." },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64Image}` },
            },
          ],
        },
      ],
      response_format: { type: "json_object" },
    });

    return JSON.parse(response.choices[0].message.content || "{}");
  } catch (err: any) {
    console.error(`[Vision Error] Failed on ${path.basename(filePath)}: ${err.message}`);
    return null;
  }
}
/* ------------------------------------------------ */
/* ---------------- MAIN PIPELINE ----------------- */
/* ------------------------------------------------ */

export async function runAssetClassification(): Promise<void> {
  console.log("==================================================");
  console.log("🏷️  OPENAI VISION ASSET CLASSIFICATION");
  console.log("==================================================");

  const semanticMap = await readJson<SemanticMap>(SEMANTIC_MAP_PATH);
  if (!semanticMap?.relevant_assets?.length) return;

  for (const asset of semanticMap.relevant_assets) {
    const techData = await probe(asset.filename);
    if (!techData) continue;

    let framePath = asset.filename;

    // Extract frame if video
    if (techData.type === "video") {
      framePath = path.join(
        process.cwd(),
        `temp_frame_${Date.now()}.jpg`
      );

      await execAsync(
        `"${ffmpeg}" -y -i "${asset.filename}" -ss 00:00:01 -frames:v 1 "${framePath}"`
      );
    }

    const semantics = await getOpenAIVisualSemantics(framePath);

    const paletteRgb = await ColorThief.getPalette(framePath, 5);
    const palette = paletteRgb.map((rgb: number[]) => {
      const hex = rgb.map((x) => x.toString(16).padStart(2, "0")).join("");
      return `#${hex}`;
    });

    if (techData.type === "video") {
      await safeUnlink(framePath);
    }

    asset.classification = {
      technical: techData,
      origin: asset.source?.includes("fal") ? "generated" : "scraped",
      aspect_ratio: techData.aspect_ratio,
      semantics: {
        ...semantics,
        palette,
      },
    } as any;

    console.log(`[classified] ${path.basename(asset.filename)}`);
  }
  // --- Add this Summary Table ---
  console.log("\n" + "=".repeat(50));
  console.log("📊 FINAL CLASSIFICATION SUMMARY");
  console.log("=".repeat(50));

  const summaryData = semanticMap.relevant_assets.map(asset => ({
    File: path.basename(asset.filename).substring(0, 20),
    Type: asset.classification?.technical?.type || "N/A",
    Shot: asset.classification?.semantics?.shot_type || "N/A",
    Mood: asset.classification?.semantics?.mood || "N/A",
    Colors: asset.classification?.semantics?.palette?.join(", ") || "N/A"
}));

console.table(summaryData);
  await writeJson(SEMANTIC_MAP_PATH, semanticMap);

  console.log("==================================================");
  console.log("✅ Classification Complete");
  console.log("==================================================");
}
