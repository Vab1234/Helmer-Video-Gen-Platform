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

// Image model: FLUX.1/2 dev (you can swap to another Fal text-to-image model)
async function generateImageWithFal(prompt: string): Promise<string> {
  const result = await fal.subscribe("fal-ai/flux/dev", {
    input: {
      prompt,
    },
  });

  const images = (result.data as any)?.images;
  if (!images || !images[0]?.url) {
    throw new Error("Fal did not return an image URL");
  }

  return images[0].url as string;
}

// Video model: Wan 2.2 text-to-video (returns { video: { url } }) 
async function generateVideoWithFal(prompt: string): Promise<string> {
  const result = await fal.subscribe("fal-ai/wan/v2.2-a14b/text-to-video", {
    input: {
      prompt,
      // you can add extra fields here later: duration, resolution, etc.
    },
  });

  const videoUrl = (result.data as any)?.video?.url;
  if (!videoUrl) {
    throw new Error("Fal did not return a video URL");
  }

  return videoUrl as string;
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

  let url: string;
  let targetDir: string;
  let preferredExt: string;
  let sourceLabel: string;

  if (modality === "image") {
    url = await generateImageWithFal(genPrompt);
    targetDir = IMG_DIR;
    preferredExt = ".jpg";
    sourceLabel = "fal-ai/flux/dev";
  } else {
    url = await generateVideoWithFal(genPrompt);
    targetDir = VID_DIR;
    preferredExt = ".mp4";
    sourceLabel = "fal-ai/wan/v2.2-a14b/text-to-video";
  }

  console.log(`[generation] Fal returned ${modality} URL:`, url);

  await ensureDir(targetDir);

  const { filePath, width, height, hash } = await downloadToDir(
    url,
    targetDir,
    preferredExt
  );

  console.log(`[generation] downloaded generated ${modality} to:`, filePath);

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

  const existingMetadata =
    (await readJson<FetchedAsset[]>(METADATA_PATH)) ?? [];
  const combinedMetadata = [...existingMetadata, asset];

  semanticMap.fetched_assets = [...(semanticMap.fetched_assets ?? []), asset];

  await writeJson(METADATA_PATH, combinedMetadata);
  await writeJson(SEMANTIC_MAP_PATH, semanticMap);

  console.log(
    `[generation] ✅ stored generated ${modality} metadata. See ${path.relative(
      process.cwd(),
      METADATA_PATH
    )} and updated semantic_map.json`
  );
}
