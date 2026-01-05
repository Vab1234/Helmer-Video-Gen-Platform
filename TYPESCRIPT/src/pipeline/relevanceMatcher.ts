import fs from "fs";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import { exec } from "child_process";
import util from "util";
import { readJson, writeJson, ensureDir } from "../utils/fileUtils";
import { SEMANTIC_MAP_PATH, DEST_DIR } from "../config/constants";
import { openaiClient } from "../openai/client";
import type { SemanticMap, FetchedAsset } from "../types/semanticMap";

const execPromise = util.promisify(exec);

// Configuration
const MIN_SCORE = 0.7; // GPT-4o is strict, so 0.7/1.0 is a good "relevant" threshold
const TOP_K_MINIMUM = 3; // Always keep at least the top 3 best matches

const RELEVANT_DIR = path.join(DEST_DIR, "relevant_assets");
const REL_IMG = path.join(RELEVANT_DIR, "images");
const REL_VID = path.join(RELEVANT_DIR, "videos");
const REL_AUD = path.join(RELEVANT_DIR, "audio");

// --- Helper: Video Frame Extraction ---
async function extractVideoFrame(videoPath: string): Promise<string | null> {
  if (!ffmpegPath) return null;
  const tempFrame = path.join(path.dirname(videoPath), `temp_${Date.now()}.jpg`);
  // Extract frame at 1.0 second mark
  const cmd = `"${ffmpegPath}" -i "${videoPath}" -ss 00:00:01.000 -vframes 1 "${tempFrame}" -y`;
  try {
    await execPromise(cmd);
    return fs.existsSync(tempFrame) ? tempFrame : null;
  } catch { return null; }
}

// --- Helper: Convert Image to Base64 ---
async function imageToBase64(filepath: string): Promise<string> {
  const data = await fs.promises.readFile(filepath);
  return data.toString("base64");
}

// --- Scoring Logic (Using OpenAI Vision) ---
async function scoreImageWithGPT(
  filepath: string, 
  userPrompt: string
): Promise<number> {
  try {
    const base64Image = await imageToBase64(filepath);
    
    const response = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini", // Cost-effective vision model
      messages: [
        {
          role: "system",
          content: `You are a strict media curator. Compare the image provided to the user prompt: "${userPrompt}". 
          Rate relevance from 0.0 (irrelevant) to 1.0 (perfect match). 
          Return ONLY a JSON object: { "score": 0.0 }`
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze this image for relevance." },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
          ],
        },
      ],
      max_tokens: 50,
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return 0;

    // Parse JSON safely (handle markdown blocks if GPT adds them)
    const cleanJson = content.replace(/```json|```/g, "").trim();
    const result = JSON.parse(cleanJson);
    return result.score || 0;

  } catch (err) {
    console.warn(`[relevance] GPT scoring failed for ${path.basename(filepath)}:`, err);
    return 0; // Fail safe
  }
}

// Simple logic for Audio (since GPT-4o-mini can't hear yet)
function scoreMetadata(asset: FetchedAsset, prompt: string): number {
  const text = `${asset.query_used} ${asset.alt || ""} ${asset.source} ${path.basename(asset.filename)}`.toLowerCase();
  const keywords = prompt.toLowerCase().split(" ").filter(w => w.length > 3);
  
  let matches = 0;
  for (const k of keywords) { 
    if (text.includes(k)) matches++; 
  }
  
  // Default score 0.5 if no keywords, up to 0.9 based on matches
  return keywords.length === 0 ? 0.5 : Math.min(0.9, 0.3 + (matches / keywords.length));
}

// --- Main Pipeline ---

export async function runRelevanceMatching(): Promise<void> {
  console.log("==================================================");
  console.log("🎯 RELEVANCE MATCHING MODULE (Step 4 - AI Vision)");
  console.log("==================================================");

  const semanticMap = await readJson<SemanticMap>(SEMANTIC_MAP_PATH);
  if (!semanticMap || !semanticMap.fetched_assets) {
    console.log("[relevance] No assets to process.");
    return;
  }

  const userPrompt = semanticMap.user_prompt || "";
  console.log(`[relevance] Judging relevance against: "${userPrompt}"`);

  await ensureDir(REL_IMG);
  await ensureDir(REL_VID);
  await ensureDir(REL_AUD);

  const scoredAssets = [];
  const total = semanticMap.fetched_assets.length;
  let current = 0;

  console.log(`[relevance] Sending ${total} assets to AI Vision Review...`);

  for (const asset of semanticMap.fetched_assets) {
    current++;
    process.stdout.write(`\r[relevance] Reviewing ${current}/${total}`);

    if (!fs.existsSync(asset.filename)) continue;
    
    let score = 0;
    try {
      if (asset.type === "image") {
        score = await scoreImageWithGPT(asset.filename, userPrompt);
      } 
      else if (asset.type === "video") {
        const framePath = await extractVideoFrame(asset.filename);
        if (framePath) {
          score = await scoreImageWithGPT(framePath, userPrompt);
          fs.unlink(framePath, () => {}); // cleanup temp frame
        } else {
           // Fallback if ffmpeg fails
           score = scoreMetadata(asset, userPrompt);
        }
      } 
      else { 
        // Audio
        score = scoreMetadata(asset, userPrompt); 
      }
    } catch (e) {
       // Ignore individual errors
    }

    scoredAssets.push({ ...asset, score });
  }
  console.log("\n[relevance] Scoring complete.");

  // 2. RANKING PHASE
  scoredAssets.sort((a, b) => b.score - a.score);

  // 3. SELECTION PHASE
  const relevantAssets: FetchedAsset[] = [];

  console.log("\n--- AI Vision Results ---");
  for (let i = 0; i < scoredAssets.length; i++) {
    const asset = scoredAssets[i];
    
    // Logic: Keep TOP K always + Keep anything above threshold
    const isTopK = i < TOP_K_MINIMUM;
    const isKeeper = asset.score >= MIN_SCORE || isTopK;

    const icon = isKeeper ? "✅" : "❌";
    const name = path.basename(asset.filename).slice(0, 25); 

    console.log(`${icon} [${asset.type}] ${name.padEnd(28)} | Score: ${asset.score.toFixed(2)}`);

    if (isKeeper) {
      const destDir = asset.type === "image" ? REL_IMG : asset.type === "video" ? REL_VID : REL_AUD;
      const destPath = path.join(destDir, path.basename(asset.filename));
      
      try {
        await fs.promises.copyFile(asset.filename, destPath);
        relevantAssets.push({ ...asset, filename: destPath });
      } catch (err) {
        console.error(`Error copying file: ${err}`);
      }
    }
  }

  semanticMap.relevant_assets = relevantAssets;
  await writeJson(SEMANTIC_MAP_PATH, semanticMap);
  console.log(`\n[done] Saved ${relevantAssets.length} verified assets to: ${RELEVANT_DIR}`);
}