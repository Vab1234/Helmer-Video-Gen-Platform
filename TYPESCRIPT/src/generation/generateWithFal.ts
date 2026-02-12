// src/generation/generateWithFal.ts
import { fal } from "@fal-ai/client";
import { readJson, writeJson, ensureDir } from "../utils/fileUtils";
import {
  SEMANTIC_MAP_PATH,
  IMG_DIR,
  VID_DIR,
  METADATA_PATH,
} from "../config/constants";
import type { SemanticMap, FetchedAsset, MediaType } from "../types/semanticMap";
import { detectModality } from "../pipeline/modalityRouting";
import { downloadToDir } from "../scraping/download";
import fs from "fs";
import path from "path";

const fsp = fs.promises;

// ----------------- helpers -----------------

function buildGenerationPrompt(map: SemanticMap, modality: MediaType): string {
  const base = map.user_prompt ?? "";

  const intent = map.intent_extraction ?? {};
  const style = (intent.style_adjectives ?? []).join(", ");

  const extraParts = [
    intent.domain,
    intent.primary_subject,
    intent.context_scene,
    style,
    modality === "video" ? "cinematic, high quality video" : "",
  ].filter(Boolean);

  const extra = extraParts.join(", ");
  if (!extra) return base;

  return `${base} | intent: ${extra}`;
}

// Image model: FLUX.1/2 dev - Generates 3 images in one request
async function generateImagesWithFal(prompt: string): Promise<string[]> {
  const result = await fal.subscribe("fal-ai/flux/dev", {
    input: {
      prompt,
      num_images: 3, 
    },
  });

  const images = (result.data as any)?.images;
  if (!images || !Array.isArray(images) || images.length === 0) {
    throw new Error("Fal did not return any image URLs");
  }

  return images.map((img: any) => img.url as string);
}

// Video model: Wan 2.2 - Triggers 3 parallel requests to get 3 unique videos
async function generateVideosWithFal(prompt: string): Promise<string[]> {
  const COUNT = 3;
  console.log(`[generation] triggering ${COUNT} parallel video generations...`);

  // Create 3 concurrent promises
  const tasks = Array.from({ length: COUNT }, () => 
    fal.subscribe("fal-ai/wan/v2.2-a14b/text-to-video", {
      input: {
        prompt,
      },
    })
  );

  // Settle all promises. We use allSettled or map to handle potential partial failures
  const results = await Promise.all(tasks);

  const videoUrls = results
    .map((res: any) => res.data?.video?.url)
    .filter(Boolean);

  if (videoUrls.length === 0) {
    throw new Error("Fal did not return any video URLs");
  }

  return videoUrls;
}

// ----------------- main entry -----------------

export async function runGenerateWithFal(): Promise<void> {
  console.log("==================================================");
  console.log("🎨 GENERATION MODULE (Fal.ai)");
  console.log("==================================================");

  const semanticMap =
    (await readJson<SemanticMap>(SEMANTIC_MAP_PATH)) ?? ({} as SemanticMap);

  if (!semanticMap.user_prompt) {
    throw new Error(
      `No semantic map found at ${SEMANTIC_MAP_PATH}. Run previous steps first.`
    );
  }

  const modality: MediaType = detectModality(semanticMap);
  console.log(`[generation] modality detected: ${modality}`);

  if (modality !== "image" && modality !== "video") {
    console.warn(
      `[generation] Fal generation is currently implemented only for 'image' and 'video'. Skipping for '${modality}'.`
    );
    return;
  }

  const genPrompt = buildGenerationPrompt(semanticMap, modality);
  console.log("[generation] using prompt for Fal:\n", genPrompt);

  let urls: string[] = []; 
  let targetDir: string;
  let preferredExt: string;
  let sourceLabel: string;

  if (modality === "image") {
    urls = await generateImagesWithFal(genPrompt);
    targetDir = IMG_DIR;
    preferredExt = ".jpg";
    sourceLabel = "fal-ai/flux/dev";
  } else {
    // modality === "video"
    urls = await generateVideosWithFal(genPrompt);
    targetDir = VID_DIR;
    preferredExt = ".mp4";
    sourceLabel = "fal-ai/wan/v2.2-a14b/text-to-video";
  }

  console.log(`[generation] Fal returned ${urls.length} ${modality} URLs`);

  await ensureDir(targetDir);

  const newAssets: FetchedAsset[] = [];

  // Iterate through all returned URLs (3 for images, 3 for videos)
  for (const url of urls) {
    try {
      console.log(`[generation] downloading ${modality}:`, url);
      const { filePath, width, height, hash } = await downloadToDir(
        url,
        targetDir,
        preferredExt
      );

      const asset: FetchedAsset = {
        type: modality,
        filename: filePath,
        source: sourceLabel,
        media_url: url,
        page_url: undefined,
        alt: modality === "image" ? semanticMap.user_prompt : undefined,
        query_used: genPrompt,
        width,
        height,
        sha256: hash,
      };

      newAssets.push(asset);
    } catch (err) {
      console.error(`[generation] Failed to download asset from ${url}:`, err);
    }
  }

  // Update Metadata and Semantic Map
  const existingMetadata = (await readJson<FetchedAsset[]>(METADATA_PATH)) ?? [];
  const combinedMetadata = [...existingMetadata, ...newAssets];

  semanticMap.fetched_assets = [...(semanticMap.fetched_assets ?? []), ...newAssets];

  await writeJson(METADATA_PATH, combinedMetadata);
  await writeJson(SEMANTIC_MAP_PATH, semanticMap);

  console.log(
    `[generation] ✅ stored ${newAssets.length} generated ${modality} assets. See ${path.relative(
      process.cwd(),
      METADATA_PATH
    )}`
  );
}