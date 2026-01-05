// src/pipeline/assetClassifier.ts
import fs from "fs";
import path from "path";
import util from "util";
import { exec } from "child_process";
import ffmpegPath from "ffmpeg-static";
import { readJson, writeJson } from "../utils/fileUtils";
import { SEMANTIC_MAP_PATH } from "../config/constants";
import { openaiClient } from "../openai/client";
import type { SemanticMap, AssetClassification } from "../types/semanticMap";

const execAsync = util.promisify(exec);

// --- HELPER: Video Frame Extraction for Analysis ---
async function extractPreviewFrame(videoPath: string): Promise<string | null> {
  if (!ffmpegPath) return null;
  const tempFrame = path.join(path.dirname(videoPath), `classify_preview_${Date.now()}.jpg`);
  try {
    // Extract at 1.0s to get a representative image
    await execAsync(`"${ffmpegPath}" -ss 00:00:01.000 -i "${videoPath}" -frames:v 1 "${tempFrame}" -y`);
    if (fs.existsSync(tempFrame)) return tempFrame;
    return null;
  } catch { return null; }
}

// --- HELPER: Technical Analysis via FFmpeg ---
async function getTechnicalStats(filepath: string, type: "image" | "video" | "audio"): Promise<AssetClassification['technical']> {
  // Default fallback
  const fallback: AssetClassification['technical'] = { orientation: "square" };
  
  if (!ffmpegPath) return fallback;

  try {
    // Run ffmpeg -i to get stream info. Robust way without extra libs.
    const { stderr } = await execAsync(`"${ffmpegPath}" -i "${filepath}"`);
    
    // Regex to parse output
    const resolutionMatch = stderr.match(/, (\d{2,5})x(\d{2,5})/); // Matches "1920x1080"
    const durationMatch = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);

    let width = 0;
    let height = 0;
    let duration = 0;

    if (resolutionMatch) {
      width = parseInt(resolutionMatch[1]);
      height = parseInt(resolutionMatch[2]);
    }

    if (durationMatch) {
      const h = parseInt(durationMatch[1]) * 3600;
      const m = parseInt(durationMatch[2]) * 60;
      const s = parseFloat(durationMatch[3]);
      duration = h + m + s;
    }

    let orientation: "landscape" | "portrait" | "square" = "landscape";
    if (width > height) orientation = "landscape";
    else if (height > width) orientation = "portrait";
    else orientation = "square";

    // File size
    const stats = await fs.promises.stat(filepath);
    const file_size_mb = (stats.size / (1024 * 1024)).toFixed(2);

    return {
      width: width || undefined,
      height: height || undefined,
      orientation,
      duration: type === "video" || type === "audio" ? duration : 0,
      file_size_mb
    };

  } catch (err) {
    console.warn(`[classifier] Tech analysis failed for ${path.basename(filepath)}`);
    return fallback;
  }
}

// --- HELPER: Semantic Analysis via GPT-4o ---
async function getSemanticTags(imagePath: string, type: string): Promise<AssetClassification['semantic']> {
  try {
    const buf = await fs.promises.readFile(imagePath);
    const base64 = buf.toString("base64");

    const prompt = `
      Analyze this ${type}. Strictly return a JSON object with:
      - shot_type: (e.g. Wide, Close-up, Macro, Drone, POV)
      - lighting: (e.g. Golden Hour, Studio, Natural, Neon, Dark)
      - mood: (e.g. Happy, Melancholic, Professional, Chaotic, Calm)
      - subject: (Short description of main focus, e.g. "Brown dog running")
      - aesthetic_score: (Number 1-10 based on composition)
      - keywords: (Array of 5 descriptive content tags)
    `;

    const response = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a professional digital asset manager. Return valid JSON only." },
        { 
          role: "user", 
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } }
          ] 
        }
      ],
      max_tokens: 200,
      temperature: 0.2,
    });

    const content = response.choices[0]?.message?.content?.trim() || "{}";
    const cleanJson = content.replace(/```json|```/g, "").trim();
    return JSON.parse(cleanJson);

  } catch (err) {
    // Fail-safe
    return {
      shot_type: "Unknown",
      lighting: "Unknown",
      mood: "Neutral",
      subject: "Asset",
      aesthetic_score: 5,
      keywords: ["processed"]
    };
  }
}

// --- MAIN PIPELINE STEP ---
export async function runAssetClassification(): Promise<void> {
  console.log("==================================================");
  console.log("🏷️  ASSET CLASSIFICATION MODULE (Step 5)");
  console.log("==================================================");

  const semanticMap = await readJson<SemanticMap>(SEMANTIC_MAP_PATH);
  
  if (!semanticMap || !semanticMap.relevant_assets || semanticMap.relevant_assets.length === 0) {
    console.log("[classifier] No relevant assets to classify.");
    return;
  }

  const assets = semanticMap.relevant_assets;
  const total = assets.length;
  let current = 0;

  console.log(`[classifier] Analyzing ${total} assets...`);

  for (const asset of assets) {
    current++;
    process.stdout.write(`\r[classifier] Processing ${current}/${total}...`);

    // 1. Technical Analysis
    const techStats = await getTechnicalStats(asset.filename, asset.type);

    // 2. Semantic Analysis
    let semanticStats: AssetClassification['semantic'];
    
    if (asset.type === "image") {
      semanticStats = await getSemanticTags(asset.filename, "image");
    } 
    else if (asset.type === "video") {
      const framePath = await extractPreviewFrame(asset.filename);
      if (framePath) {
        semanticStats = await getSemanticTags(framePath, "video frame");
        fs.unlink(framePath, () => {}); // Cleanup temp frame
      } else {
        // Fallback if ffmpeg fails to extract frame
        semanticStats = { shot_type: "Video", lighting: "Unknown", mood: "Unknown", subject: "Video", aesthetic_score: 5, keywords: ["video"] };
      }
    } 
    else {
      // Audio (Skip vision)
      semanticStats = { 
        shot_type: "N/A", 
        lighting: "N/A", 
        mood: "Audio", 
        subject: "Sound", 
        aesthetic_score: 5, 
        keywords: ["audio", "sfx"] 
      };
    }

    // 3. Attach Data
    asset.classification = {
      technical: techStats as any,
      semantic: semanticStats
    };
  }

  console.log("\n[classifier] Classification complete.");

  // Save updated map
  await writeJson(SEMANTIC_MAP_PATH, semanticMap);
  
  // Summary Log
  console.log("\n--- Classification Report ---");
  assets.forEach(a => {
    const c = a.classification;
    if (c) {
      console.log(`\n📄 ${path.basename(a.filename)} (${a.type})`);
      console.log(`   └─ Tech: ${c.technical.orientation} | ${c.technical.width || '?'}x${c.technical.height || '?'} | ${c.technical.duration?.toFixed(1)}s`);
      console.log(`   └─ Sem:  ${c.semantic.mood} | ${c.semantic.lighting} | Score: ${c.semantic.aesthetic_score}/10`);
    }
  });
}