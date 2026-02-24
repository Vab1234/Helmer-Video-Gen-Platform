import fs from "fs";
import path from "path";
import sharp from "sharp";
import OpenAI from "openai";
import { readJson, writeJson, ensureDir } from "../utils/fileUtils";
import { SEMANTIC_MAP_PATH, DEST_DIR } from "../config/constants";
import type { SemanticMap, FetchedAsset } from "../types/semanticMap";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const REL_IMG = path.join(DEST_DIR, "relevant_assets", "images");
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
  console.log("==================================================");
  console.log("🎯 INTENT-AWARE RELEVANCE MATCHING");
  console.log("==================================================");

  const semanticMap = await readJson<SemanticMap>(SEMANTIC_MAP_PATH);
  if (!semanticMap?.fetched_assets?.length) return;

  const prompt = semanticMap.user_prompt;
  const intent = await extractIntent(prompt);

  console.log("🧠 Intent Extracted:", intent);

  const images = semanticMap.fetched_assets.filter(a => a.type === "image");
  const finalRelevantAssets: FetchedAsset[] = [];

  await ensureDir(REL_IMG);

  for (let i = 0; i < images.length; i += BATCH_SIZE) {
    const batch = images.slice(i, i + BATCH_SIZE);

    const contentParts = [];
    const validAssets: FetchedAsset[] = [];

    for (const asset of batch) {
      const dataUrl = await processImageForAPI(asset.filename);
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
      if (r.score >= MIN_SCORE) {
        const asset = validAssets[r.index];
        if (!asset) continue;

        const dest = path.join(REL_IMG, path.basename(asset.filename));
        await fs.promises.copyFile(asset.filename, dest);

        finalRelevantAssets.push({ ...asset, filename: dest });

        console.log(`✅ Selected (${r.score.toFixed(2)}): ${path.basename(asset.filename)}`);
      } else {
        console.log(`❌ Rejected (${r.score.toFixed(2)}): ${validAssets[r.index]?.filename}`);
      }
    }
  }

  semanticMap.relevant_assets = finalRelevantAssets;
  await writeJson(SEMANTIC_MAP_PATH, semanticMap);

  console.log(`\n✨ Finished. Selected: ${finalRelevantAssets.length}`);
}