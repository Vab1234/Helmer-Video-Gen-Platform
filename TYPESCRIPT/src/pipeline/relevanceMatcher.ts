// src/pipeline/relevanceMatching.ts

import fs from "fs";
import path from "path";
import sharp from "sharp";
import OpenAI from "openai";

import { readJson, writeJson, ensureDir } from "../utils/fileUtils";
import { SEMANTIC_MAP_PATH, DEST_DIR } from "../config/constants";
import type { SemanticMap, FetchedAsset } from "../types/semanticMap";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MIN_SCORE = 0.55;
const TOP_K_MINIMUM = 5;

const RELEVANT_DIR = path.join(DEST_DIR, "relevant_assets");
const REL_IMG = path.join(RELEVANT_DIR, "images");
const REL_VID = path.join(RELEVANT_DIR, "videos");
const REL_AUD = path.join(RELEVANT_DIR, "audio");

/* ----------------------- HELPERS ----------------------- */

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (magA * magB);
}

async function validateImage(filePath: string): Promise<boolean> {
  try {
    if (!fs.existsSync(filePath)) return false;
    await sharp(filePath).metadata();
    return true;
  } catch {
    return false;
  }
}

async function getImageCaption(filePath: string): Promise<string | null> {
  try {
    const buffer = fs.readFileSync(filePath);

    // 🔥 Detect real format using sharp
    const metadata = await sharp(buffer).metadata();

    if (!metadata.format) {
      console.warn("Unknown format:", filePath);
      return null;
    }

    const mimeType = `image/${metadata.format}`;
    const base64 = buffer.toString("base64");

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: "Describe this image briefly in one clear sentence.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "What is happening in this image?" },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64}`,
              },
            },
          ],
        },
      ],
    });

    return response.choices[0].message.content || null;
  } catch (err) {
    console.error("Caption error:", filePath, err);
    return null;
  }
}


async function getEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });

  return response.data[0].embedding;
}

/* ----------------------- MAIN ----------------------- */

export async function runRelevanceMatching(): Promise<void> {
  console.log("==================================================");
  console.log("🎯 OPENAI RELEVANCE MATCHING (NO CLIP)");
  console.log("==================================================");

  const semanticMap = await readJson<SemanticMap>(SEMANTIC_MAP_PATH);
  if (!semanticMap?.fetched_assets?.length) return;

  const userPrompt = semanticMap.user_prompt;

  // Embed prompt once
  const promptEmbedding = await getEmbedding(userPrompt);

  await ensureDir(REL_IMG);
  await ensureDir(REL_VID);
  await ensureDir(REL_AUD);

  const scoredAssets: (FetchedAsset & { score: number })[] = [];

  for (const asset of semanticMap.fetched_assets) {
    if (asset.type !== "image") continue;

    const isValid = await validateImage(asset.filename);
    if (!isValid) {
      await fs.promises.unlink(asset.filename).catch(() => {});
      continue;
    }

    const caption = await getImageCaption(asset.filename);
    if (!caption) continue;

    const captionEmbedding = await getEmbedding(caption);

    const similarity = cosineSimilarity(promptEmbedding, captionEmbedding);

    scoredAssets.push({ ...asset, score: similarity });

    console.log(
      `[score] ${similarity.toFixed(4)} | ${path.basename(asset.filename)}`
    );
  }

  scoredAssets.sort((a, b) => b.score - a.score);

  const relevantAssets: FetchedAsset[] = [];

  for (let i = 0; i < scoredAssets.length; i++) {
    const asset = scoredAssets[i];
    const isTopK = i < TOP_K_MINIMUM;
    const isKeeper = asset.score >= MIN_SCORE || isTopK;

    console.log(
      `[select] ${isKeeper ? "✅ KEEP" : "❌ SKIP"} | ${asset.score.toFixed(
        4
      )} | ${path.basename(asset.filename)}`
    );

    if (isKeeper) {
      const destPath = path.join(REL_IMG, path.basename(asset.filename));
      await fs.promises.copyFile(asset.filename, destPath);
      relevantAssets.push({ ...asset, filename: destPath });
    }
  }

  semanticMap.relevant_assets = relevantAssets;
  semanticMap.fetched_assets = [];

  await writeJson(SEMANTIC_MAP_PATH, semanticMap);

  console.log("==================================================");
  console.log(`✅ ${relevantAssets.length} relevant assets selected`);
  console.log("==================================================");
}
