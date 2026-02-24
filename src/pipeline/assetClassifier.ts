// src/pipeline/assetClassifier.ts

import fs from "fs";
import path from "path";
import util from "util";
import { exec } from "child_process";
import ffprobe from "ffprobe-static";
import ffmpeg from "ffmpeg-static";
import OpenAI from "openai";
import sizeOf from "image-size";
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
            {
  type: "text",
  text: `
Analyze this image and return structured JSON describing its visual semantics.

Return ONLY valid JSON with the following fields:

{
  "primary_scene": "",
  "environment": "",
  "time_of_day": "",
  "weather": "",
  "indoor_outdoor": "",

  "shot_type": "",
  "camera_angle": "",
  "composition": "",
  "lighting": "",

  "mood": "",
  "atmosphere": "",

  "human_presence": true,
  "people_count_estimate": 0,
  "primary_activity": "",

  "dominant_objects": [],
  "tags": [],

  "confidence": 0.0
}

Guidelines:
- Describe what is visually observable.
- Do NOT invent unseen details.
- Keep tags useful for media search.
- Use simple professional terminology.
`
},
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

      let palette: string[] = [];

      try {
        const paletteRgb = await ColorThief.getPalette(framePath, 5);
        palette = paletteRgb.map((rgb: number[]) =>
          "#" + rgb.map((x) => x.toString(16).padStart(2, "0")).join("")
        );
      } catch {
        palette = [];
      }
    if (techData.type === "video") {
      await safeUnlink(framePath);
    }

    asset.classification = {
      technical: techData,
      origin: asset.source?.includes("fal") ? "generated" : "scraped",
      aspect_ratio: techData.aspect_ratio,
      semantics: {
        ...(semantics || {}),
        palette,
      },
    } as any;

    console.log(`[classified] ${path.basename(asset.filename)}`);
  }
  console.log("\n" + "=".repeat(60));
console.log("🎯 FINAL RELEVANT ASSETS");
console.log("=".repeat(60));

semanticMap.relevant_assets.forEach((asset, i) => {
  const tech = asset.classification?.technical as any;
  const sem = asset.classification?.semantics || {};

  console.log(`\n🖼️  Asset ${i + 1}`);
  console.log("-".repeat(60));

  console.log(`File        : ${path.basename(asset.filename)}`);
  console.log(`Source      : ${asset.source}`);
  console.log(`Type        : ${tech.type}`);
  console.log(`Resolution  : ${tech.width}x${tech.height}`);
  console.log(`Aspect Ratio: ${tech.aspect_ratio}`);

  console.log("\n📍 Scene Understanding");
  console.log(`Scene       : ${sem.primary_scene || "N/A"}`);
  console.log(`Environment : ${sem.environment || "N/A"}`);
  console.log(`Time of Day : ${sem.time_of_day || "N/A"}`);
  console.log(`Weather     : ${sem.weather || "N/A"}`);

  console.log("\n🎬 Cinematic Attributes");
  console.log(`Lighting    : ${sem.lighting || "N/A"}`);
  console.log(`Shot Type   : ${sem.shot_type || "N/A"}`);
  console.log(`Camera Angle: ${sem.camera_angle || "N/A"}`);
  console.log(`Mood        : ${sem.mood || "N/A"}`);

  console.log("\n👤 Content");
  console.log(`Human       : ${sem.human_presence ?? "N/A"}`);
  console.log(`Activity    : ${sem.primary_activity || "N/A"}`);

  console.log("\n🏷️ Tags");
  console.log(`${(sem.tags || []).join(", ") || "N/A"}`);

  console.log("\n🎨 Color Palette");
  console.log(`${(sem.palette || []).join(", ") || "N/A"}`);
});
const summaryData = semanticMap.relevant_assets.map(asset => ({
  File: path.basename(asset.filename),
  Scene: asset.classification?.semantics?.primary_scene || "N/A",
  Mood: asset.classification?.semantics?.mood || "N/A",
  Lighting: asset.classification?.semantics?.lighting || "N/A"
}));

console.table(summaryData);
const finalResults = semanticMap.relevant_assets.map(asset => ({
  file: path.basename(asset.filename),
  source: asset.source || "unknown",
  type: asset.classification?.technical?.type,
  width: asset.classification?.technical?.width,
  height: asset.classification?.technical?.height,
  aspect_ratio: asset.classification?.technical?.aspect_ratio,

  classification: asset.classification?.semantics || {},
}));

// Replace semantic map output with clean results
  semanticMap.results = finalResults;
  delete semanticMap.fetched_assets;
  delete semanticMap.relevant_assets;
  await writeJson(SEMANTIC_MAP_PATH, semanticMap);


  console.log("==================================================");
  console.log("✅ Classification Complete");
  console.log("==================================================");
}
