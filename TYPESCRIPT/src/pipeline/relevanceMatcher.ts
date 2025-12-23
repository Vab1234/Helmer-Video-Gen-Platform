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
const MIN_SCORE = 0.21; 
const TOP_K_MINIMUM = 5;

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
  const cmd = `"${ffmpegPath}" -i "${videoPath}" -ss 00:00:01 -vframes 1 "${tempFrame}" -y`;
  try {
    await execPromise(cmd);
    return fs.existsSync(tempFrame) ? tempFrame : null;
  } catch { return null; }
}

async function scoreImage(
  filepath: string, 
  prompt: string, 
  clipPipe: any
): Promise<number> {
  try {
    // Basic contrast: prompt vs. a single static negative label
    const candidateLabels = [prompt, "unrelated random object or blurred background"];
    const output = await clipPipe(filepath, candidateLabels);

    if (Array.isArray(output) && output.length > 0) {
      // Find the score for the user prompt specifically
      const match = output.find((item: any) => item.label === prompt);
      return match ? match.score : 0;
    }
    return 0;
  } catch (err) {
    return 0;
  }
}

function scoreMetadata(asset: FetchedAsset, subjects: string[]): number {
  const text = `${asset.query_used} ${asset.alt || ""} ${asset.source}`.toLowerCase();
  let matches = 0;
  for (const sub of subjects) { 
    if (text.includes(sub.toLowerCase())) matches++; 
  }
  return subjects.length === 0 ? 0.5 : matches / subjects.length;
}

export async function runRelevanceMatching(): Promise<void> {
  console.log("==================================================");
  console.log("🎯 RELEVANCE MATCHING MODULE (Step 4)");
  console.log("==================================================");

  const semanticMap = await readJson<SemanticMap>(SEMANTIC_MAP_PATH);
  if (!semanticMap || !semanticMap.fetched_assets) return;

  const userPrompt = semanticMap.user_prompt || "";
  const subjects = extractSubjects(userPrompt);

  const dynamicImport = new Function('specifier', 'return import(specifier)');
  const { pipeline, env } = await dynamicImport("@xenova/transformers");
  env.allowLocalModels = false;
  
  const clipPipe = await pipeline("zero-shot-image-classification", CLIP_MODEL_ID);

  await ensureDir(REL_IMG);
  await ensureDir(REL_VID);
  await ensureDir(REL_AUD);

  // 1. SCORING PHASE
  const scoredAssets = [];
  for (const asset of semanticMap.fetched_assets) {
    if (!fs.existsSync(asset.filename)) continue;
    
    let score = 0;
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
    else { 
      score = scoreMetadata(asset, subjects); 
    }
    scoredAssets.push({ ...asset, score });
  }

  // 2. RANKING PHASE
  scoredAssets.sort((a, b) => b.score - a.score);

  // 3. SELECTION & COPYING PHASE
  const relevantAssets: FetchedAsset[] = [];

  for (let i = 0; i < scoredAssets.length; i++) {
    const asset = scoredAssets[i];
    const isTopK = i < TOP_K_MINIMUM;
    const threshold = asset.type === "audio" ? 0.15 : MIN_SCORE;
    
    // Dynamic threshold: Keep if meets score OR is in the top 5
    const isKeeper = asset.score >= threshold || isTopK;

    console.log(`[score] ${asset.type.padEnd(5)} | Score: ${asset.score.toFixed(4)} | ${isKeeper ? "✅ KEEP" : "❌ SKIP"} | ${path.basename(asset.filename)}`);

    if (isKeeper) {
      const destDir = asset.type === "image" ? REL_IMG : asset.type === "video" ? REL_VID : REL_AUD;
      const destPath = path.join(destDir, path.basename(asset.filename));
      
      try {
        // Copy files so originals remain in the scrape folder
        await fs.promises.copyFile(asset.filename, destPath);
        relevantAssets.push({ ...asset, filename: destPath });
      } catch (err) {
        console.error(`Error copying file: ${err}`);
      }
    }
  }

  semanticMap.relevant_assets = relevantAssets;
  semanticMap.fetched_assets = []; // Clear for next potential loop attempt

  await writeJson(SEMANTIC_MAP_PATH, semanticMap);
  console.log(`\n[done] All scraped assets preserved in original folders.`);
  console.log(`[done] ${relevantAssets.length} relevant assets copied to: ${RELEVANT_DIR}`);
}