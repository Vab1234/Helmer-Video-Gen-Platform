import fs from "fs";
import path from "path";
import nlp from "compromise";
import ffmpegPath from "ffmpeg-static";
import { exec } from "child_process";
import util from "util";
import { readJson, writeJson, ensureDir } from "../utils/fileUtils";
import { SEMANTIC_MAP_PATH, DEST_DIR } from "../config/constants";
import type { SemanticMap, FetchedAsset } from "../types/semanticMap";

const execPromise = util.promisify(exec);

// Configuration
const CLIP_MODEL_ID = "Xenova/clip-vit-base-patch32";
const MIN_SCORE = 0.21; // Threshold for filtering

// Directories
const RELEVANT_DIR = path.join(DEST_DIR, "relevant_assets");
const REL_IMG = path.join(RELEVANT_DIR, "images");
const REL_VID = path.join(RELEVANT_DIR, "videos");
const REL_AUD = path.join(RELEVANT_DIR, "audio");

function extractSubjects(text: string): string[] {
  const doc = nlp(text);
  return doc.nouns().out("array");
}

async function extractVideoFrame(videoPath: string): Promise<string | null> {
  if (!ffmpegPath) return null;
  const tempFrame = path.join(path.dirname(videoPath), `temp_${Date.now()}.jpg`);
  
  // Extract frame at 1 second mark
  const cmd = `"${ffmpegPath}" -i "${videoPath}" -ss 00:00:01 -vframes 1 "${tempFrame}" -y`;

  try {
    await execPromise(cmd);
    if (fs.existsSync(tempFrame)) {
      return tempFrame;
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function scoreImage(
  filepath: string,
  prompt: string,
  clipPipe: any
): Promise<number> {
  try {
    const output = await clipPipe(filepath, [prompt]);
    if (Array.isArray(output) && output.length > 0) {
      return output[0].score;
    }
    return 0;
  } catch (err) {
    return 0;
  }
}

function scoreMetadata(asset: FetchedAsset, subjects: string[]): number {
  const text = (
    `${asset.query_used} ${asset.alt || ""} ${asset.source} ${path.basename(asset.filename)}`
  ).toLowerCase();

  let matches = 0;
  for (const sub of subjects) {
    if (text.includes(sub.toLowerCase())) matches++;
  }
  
  if (subjects.length === 0) return 0.5;
  return matches / subjects.length;
}

export async function runRelevanceMatching(): Promise<void> {
  console.log("==================================================");
  console.log("🎯 RELEVANCE MATCHING MODULE (Step 4)");
  console.log("==================================================");

  const semanticMap = await readJson<SemanticMap>(SEMANTIC_MAP_PATH);
  if (!semanticMap || !semanticMap.fetched_assets) {
    console.log("[relevance] No assets to process.");
    return;
  }

  const userPrompt = semanticMap.user_prompt || "";
  const subjects = extractSubjects(userPrompt);
  console.log(`[relevance] extracted subjects: ${subjects.join(", ")}`);

  console.log("[relevance] Loading CLIP model (Note: First run downloads ~350MB, please wait)...");
  
  // DYNAMIC IMPORT FIX + PROGRESS CALLBACK
  const dynamicImport = new Function('specifier', 'return import(specifier)');
  const { pipeline, env } = await dynamicImport("@xenova/transformers");

  env.allowLocalModels = false;
  
  // Add progress callback to see download status
  const clipPipe = await pipeline("zero-shot-image-classification", CLIP_MODEL_ID, {
    progress_callback: (data: any) => {
        if (data.status === 'progress') {
            const pct = data.progress ? (data.progress).toFixed(1) : 0;
            process.stdout.write(`\r[relevance] Downloading model: ${pct}% ${data.file || ''}`);
        }
    }
  });
  console.log("\n[relevance] Model loaded.");

  await ensureDir(REL_IMG);
  await ensureDir(REL_VID);
  await ensureDir(REL_AUD);

  const relevantAssets: FetchedAsset[] = [];
  const assetsToDelete: string[] = [];

  for (const asset of semanticMap.fetched_assets) {
    let score = 0;
    
    if (!fs.existsSync(asset.filename)) continue;

    if (asset.type === "image") {
      score = await scoreImage(asset.filename, userPrompt, clipPipe);
    } 
    else if (asset.type === "video") {
      const framePath = await extractVideoFrame(asset.filename);
      if (framePath) {
        score = await scoreImage(framePath, userPrompt, clipPipe);
        fs.unlink(framePath, () => {}); 
      } else {
        score = scoreMetadata(asset, subjects);
      }
    } 
    else if (asset.type === "audio") {
      score = scoreMetadata(asset, subjects);
      if (asset.source === "freesound") score += 0.25;
    }

    const threshold = asset.type === "audio" ? 0.15 : MIN_SCORE;
    const isKeeper = score >= threshold;

    console.log(`[score] ${asset.type.padEnd(5)} | Score: ${score.toFixed(2)} | ${isKeeper ? "✅ KEEP" : "❌ DROP"} | ${path.basename(asset.filename)}`);

    if (isKeeper) {
      const destDir = asset.type === "image" ? REL_IMG : asset.type === "video" ? REL_VID : REL_AUD;
      const destPath = path.join(destDir, path.basename(asset.filename));
      
      try {
        await fs.promises.rename(asset.filename, destPath);
        asset.filename = destPath; 
        relevantAssets.push(asset);
      } catch (err) {
        console.error(`Error moving file: ${err}`);
      }
    } else {
      assetsToDelete.push(asset.filename);
    }
  }

  // Cleanup dropped files
  for (const f of assetsToDelete) {
    try { if(fs.existsSync(f)) await fs.promises.unlink(f); } catch(e) {}
  }

  semanticMap.relevant_assets = relevantAssets;
  delete semanticMap.fetched_assets; 

  await writeJson(SEMANTIC_MAP_PATH, semanticMap);
  
  console.log(`[relevance] Process complete.`);
  console.log(`[relevance] Relevant assets stored in: ${RELEVANT_DIR}`);
}