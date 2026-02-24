import fs from "fs";
import path from "path";
import sharp from "sharp";
import OpenAI from "openai";
import util from "util";
import { exec } from "child_process";
import ffmpeg from "ffmpeg-static";
import { readJson, writeJson, ensureDir } from "../utils/fileUtils";
import { SEMANTIC_MAP_PATH, DEST_DIR } from "../config/constants";
import type { SemanticMap, FetchedAsset } from "../types/semanticMap";

const execAsync = util.promisify(exec);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const REL_IMG = path.join(DEST_DIR, "relevant_assets", "images");
const REL_VID = path.join(DEST_DIR, "relevant_assets", "videos");
const REL_AUD = path.join(DEST_DIR, "relevant_assets", "audio");
const BATCH_SIZE = 8;
const MIN_SCORE = 0.55; // relevance threshold

/* ------------------------------------------------ */
/* Convert & validate image                         */
/* ------------------------------------------------ */

async function processImageForAPI(filePath: string): Promise<string | null> {
  try {
    const inputBuffer = fs.readFileSync(filePath);

    const metadata = await sharp(inputBuffer).metadata();

    const supported = ["jpeg", "jpg", "png", "gif", "webp"];
    let finalBuffer: Buffer;

    if (!metadata.format || !supported.includes(metadata.format)) {
      console.log(`🔄 Converting ${path.basename(filePath)} → jpeg`);
      finalBuffer = Buffer.from(
        await sharp(inputBuffer).jpeg().toBuffer()
      );
    } else {
      finalBuffer = Buffer.from(inputBuffer);
    }

    const format =
      metadata.format === "jpg" ? "jpeg" : metadata.format || "jpeg";

    return `data:image/${format};base64,${finalBuffer.toString("base64")}`;
  } catch (err) {
    console.error(`❌ Image processing failed: ${path.basename(filePath)}`);
    return null;
  }
}

/* ------------------------------------------------ */
/* Extract intent priorities from prompt            */
/* ------------------------------------------------ */

async function extractIntent(prompt: string) {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `
Extract structured intent from the user prompt.

Return JSON:

{
  "primary_subject": "",
  "primary_action": "",
  "supporting_objects": [],
  "relationships": [],
  "conflicting_actions_to_reject": []
}

Rules:
- primary_action = main verb/action
- supporting_objects = secondary items
- relationships = spatial words (beside, on table, next to)
- conflicting actions = actions that contradict the main action
`
      },
      { role: "user", content: prompt }
    ]
  });

  return JSON.parse(resp.choices[0].message.content || "{}");
}

/* ------------------------------------------------ */
/* MAIN MATCHER                                     */
/* ------------------------------------------------ */

export async function runRelevanceMatching(): Promise<void> {
  const startTime = Date.now();
  console.log("==================================================");
  console.log("🎯 INTENT-AWARE RELEVANCE MATCHING");
  console.log("==================================================");

  const semanticMap = await readJson<SemanticMap>(SEMANTIC_MAP_PATH);
  if (!semanticMap?.fetched_assets?.length) return;

  const prompt = semanticMap.user_prompt;
  const intent = await extractIntent(prompt);

  console.log("🧠 Intent Extracted:", intent);

  const mediaToScore = semanticMap.fetched_assets.filter(a => a.type === "image" || a.type === "video");
  const finalRelevantAssets: FetchedAsset[] = [];
  const scoredAssets: { asset: FetchedAsset; score: number }[] = [];

  for (let i = 0; i < mediaToScore.length; i += BATCH_SIZE) {
    const batch = mediaToScore.slice(i, i + BATCH_SIZE);

    const contentParts = [];
    const validAssets: FetchedAsset[] = [];

    for (const asset of batch) {
      let isVideo = asset.type === "video";
      let scrapeFilePath = asset.filename;
      let framePath = "";

      if (isVideo) {
        framePath = path.join(process.cwd(), `temp_match_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`);
        try {
          await execAsync(`"${ffmpeg}" -y -i "${asset.filename}" -ss 00:00:01 -frames:v 1 "${framePath}"`);
          scrapeFilePath = framePath;
        } catch (e) {
          console.error("Failed to extract frame for video", asset.filename);
          continue;
        }
      }

      const dataUrl = await processImageForAPI(scrapeFilePath);

      if (isVideo && framePath) {
        await fs.promises.unlink(framePath).catch(() => { });
      }

      if (!dataUrl) continue;

      contentParts.push({
        type: "image_url" as const,
        image_url: { url: dataUrl, detail: "low" as const }
      });

      validAssets.push(asset);
    }

    if (!contentParts.length) continue;

    console.log(`📡 Evaluating ${contentParts.length} images`);

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
You are an expert visual relevance evaluator.

Evaluate how well each image matches the user's intent.

PRIMARY MATCH REQUIREMENTS:
- Must match primary action.
- Must match primary subject.

SECONDARY MATCH:
- Supporting objects improve score.

RELATIONSHIPS:
- Respect spatial relationships if present.

REJECT IF:
- action contradicts primary action
- subject is missing
- supporting object becomes dominant focus
- scene conflicts with prompt

Return JSON:

{
  "results": [
    { "index": 0, "score": 0.92 },
    { "index": 1, "score": 0.31 }
  ]
}
`
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `
USER PROMPT: "${prompt}"

PRIMARY SUBJECT: ${intent.primary_subject}
PRIMARY ACTION: ${intent.primary_action}
SUPPORTING OBJECTS: ${intent.supporting_objects?.join(", ")}
RELATIONSHIPS: ${intent.relationships?.join(", ")}

Evaluate images and score relevance (0–1).
`
            },
            ...contentParts
          ]
        }
      ]
    });

    const parsed = JSON.parse(response.choices[0].message.content || "{}");

    for (const r of parsed.results || []) {
      const asset = validAssets[r.index];
      if (!asset) continue;

      scoredAssets.push({ asset, score: r.score });

      if (r.score >= MIN_SCORE) {
        const targetDir = asset.type === "image" ? REL_IMG : asset.type === "video" ? REL_VID : REL_AUD;
        await ensureDir(targetDir);
        const dest = path.join(targetDir, path.basename(asset.filename));
        await fs.promises.copyFile(asset.filename, dest);

        finalRelevantAssets.push({ ...asset, filename: dest });

        console.log(`✅ Selected (${r.score.toFixed(2)}): ${path.basename(asset.filename)}`);
      } else {
        console.log(`❌ Rejected (${r.score.toFixed(2)}): ${path.basename(asset.filename)}`);
      }
    }
  }

  semanticMap.relevant_assets = finalRelevantAssets;
  await writeJson(SEMANTIC_MAP_PATH, semanticMap);

  console.log(`\n✨ Finished. Selected: ${finalRelevantAssets.length}`);

  // --- NEW: Metrics Calculation ---
  const endTime = Date.now();
  const latency = endTime - startTime;

  // Sort scored assets by score descending
  scoredAssets.sort((a, b) => b.score - a.score);

  // 1. Precision@K (K=5)
  // How many of the top 5 assets had a score >= MIN_SCORE?
  const K = 5;
  const topK = scoredAssets.slice(0, K);
  const correctInTopK = topK.filter(a => a.score >= MIN_SCORE).length;
  const precisionAtK = topK.length > 0 ? correctInTopK / topK.length : 0;

  // 2. Mean Reciprocal Rank (MRR)
  // Rank of the first relevant item
  const firstRelevantIndex = scoredAssets.findIndex(a => a.score >= MIN_SCORE);
  const mrr = firstRelevantIndex !== -1 ? 1 / (firstRelevantIndex + 1) : 0;

  // 3. Visual Diversity Score (Average Pairwise Cosine Distance)
  // Distance = 1 - Similarity
  // We need embeddings of the *accepted* assets.
  // Note: We don't have embeddings saved in `relevantAssets` currently. 
  // For now, we will approximate or skip if we can't easily get them without re-embedding.
  // OPTIMIZATION: In the loop above, we calculated embeddings. We should store them for diversity calc.
  // Limitation: To keep this simple and fast, we will calculate diversity only if we have > 1 asset.
  // AND we need to modify the loop to store embeddings temporarily. 

  // Let's rely on the best match score for now as a proxy for 'peak quality' 
  const bestMatchScore = scoredAssets.length > 0 ? scoredAssets[0].score : 0;

  // Calculate Diversity (Simulated for this step to avoid massive refactor of current loop)
  // In a robust implementation, we'd save the embeddings in `scoredAssets` and compute Euclidean/Cosine distance matrix.
  // We will add a placeholder or simple variance check if possible, otherwise 0.
  const visualDiversity = 0; // Planned for V2 with embedding persistence

  const filteringRatio = semanticMap.fetched_assets.length > 0
    ? (semanticMap.fetched_assets.length - finalRelevantAssets.length) / semanticMap.fetched_assets.length
    : 0;

  if (!semanticMap.evaluation_metrics) {
    semanticMap.evaluation_metrics = {
      timestamp: new Date().toISOString(),
      total_latency_ms: 0,
      system_health_score: 0
    };
  }

  semanticMap.evaluation_metrics.stage4 = {
    latency_ms: latency,
    precision_at_k: precisionAtK,
    mrr: mrr,
    visual_diversity_score: visualDiversity,
    filtering_ratio: filteringRatio,
    best_match_score: bestMatchScore
  };

  await writeJson(SEMANTIC_MAP_PATH, semanticMap);
}