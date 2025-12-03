// src/scraping/fetchAssets.ts
import fs from "fs";
import path from "path";
import { createBrowser, newPage } from "./browser";
import { buildSearchQueries } from "../scraping/queryBuilder";
import { detectModality } from "../pipeline/modalityRouting";
import { readJson, writeJson, ensureDir } from "../utils/fileUtils";
import {
  DEST_DIR,
  IMG_DIR,
  VID_DIR,
  AUD_DIR,
  METADATA_PATH,
  SEMANTIC_MAP_PATH,
  MAX_PER_PROVIDER,
} from "../config/constants";
import type { SemanticMap, FetchedAsset, MediaType } from "../types/semanticMap";
import { downloadToDir } from "./download";
import {
  scrapeUnsplashImages,
  scrapePexelsImages,
  scrapePixabayImages,
  ScrapedItem,
} from "./imageProviders";
import { scrapePixabayVideos, scrapePexelsVideos } from "./videoProviders";
import { scrapeMixkitSounds } from "./audioProviders";

const fsp = fs.promises;

type ProviderFn =
  | ((page: any, q: string, limit: number) => Promise<ScrapedItem[]>)
  | ((browser: any, q: string, limit: number) => Promise<ScrapedItem[]>);

async function fetchAndSave(items: ScrapedItem[]): Promise<FetchedAsset[]> {
  const metadata: FetchedAsset[] = [];
  const seenHashes = new Set<string>();

  await ensureDir(DEST_DIR);
  await ensureDir(IMG_DIR);
  await ensureDir(VID_DIR);
  await ensureDir(AUD_DIR);

  for (const item of items) {
    const { type, mediaUrl } = item;
    if (!mediaUrl) continue;

    try {
      const targetDir =
        type === "image" ? IMG_DIR : type === "video" ? VID_DIR : AUD_DIR;

      const preferredExt =
        type === "image" ? ".jpg" : type === "video" ? ".mp4" : ".mp3";

      const { filePath, contentType, width, height, hash } = await downloadToDir(
        mediaUrl,
        targetDir,
        preferredExt
      );

      if (seenHashes.has(hash)) {
        await fsp.unlink(filePath).catch(() => {});
        continue;
      }
      seenHashes.add(hash);

      const asset: FetchedAsset = {
        type,
        filename: filePath,
        source: item.source,
        media_url: mediaUrl,
        page_url: item.pageUrl,
        alt: item.alt,
        query_used: item.query,
        width,
        height,
        sha256: hash,
      };

      metadata.push(asset);
      console.log(`[saved] ${type}: ${filePath}`);
    } catch (err) {
      console.warn("[download error]", err);
    }
  }

  return metadata;
}

export async function runFetchAssets(): Promise<void> {
  console.log("==================================================");
  console.log("📡 FETCH ASSETS MODULE (Step 3)");
  console.log("==================================================");

  const semanticMap =
    (await readJson<SemanticMap>(SEMANTIC_MAP_PATH)) ?? ({} as SemanticMap);

  if (!semanticMap.user_prompt) {
    throw new Error(
      `No semantic map found at ${SEMANTIC_MAP_PATH}. Run previous steps first.`
    );
  }

  const modality: MediaType = detectModality(semanticMap);
  console.log(`[route] modality detected: ${modality}`);

  const queryObj = await buildSearchQueries(semanticMap, modality);
  const queries = (queryObj.queries || [])
    .map((q) => q.trim())
    .filter((q) => q.length > 1);

  if (!queries.length) {
    console.log("[llm] no queries generated — exiting.");
    return;
  }

  console.log("[llm] queries:", queries);

  const browser = await createBrowser();
  const collected: ScrapedItem[] = [];

  try {
    if (modality === "image") {
      const page = await newPage(browser);
      for (const q of queries) {
        console.log(`[scrape] unsplash -> '${q}'`);
        collected.push(...(await scrapeUnsplashImages(page, q, MAX_PER_PROVIDER)));

        console.log(`[scrape] pexels -> '${q}'`);
        collected.push(...(await scrapePexelsImages(page, q, MAX_PER_PROVIDER)));

        console.log(`[scrape] pixabay -> '${q}'`);
        collected.push(...(await scrapePixabayImages(page, q, MAX_PER_PROVIDER)));
      }
      await page.close();
    } else if (modality === "video") {
      for (const q of queries) {
        console.log(`[scrape] pixabay_videos -> '${q}'`);
        collected.push(...(await scrapePixabayVideos(browser, q, MAX_PER_PROVIDER)));

        console.log(`[scrape] pexels_videos -> '${q}'`);
        collected.push(...(await scrapePexelsVideos(browser, q, MAX_PER_PROVIDER)));
      }
    } else {
      for (const q of queries) {
        console.log(`[scrape] mixkit_sounds -> '${q}'`);
        collected.push(...(await scrapeMixkitSounds(browser, q, MAX_PER_PROVIDER)));
      }
    }

    console.log(`[scrape] total collected items: ${collected.length}`);

    const meta = await fetchAndSave(collected);

    // update semantic_map + metadata.json
    const existingMetadata =
      (await readJson<FetchedAsset[]>(METADATA_PATH)) ?? [];

    const combinedMetadata = [...existingMetadata, ...meta];

    semanticMap.fetched_assets = [...(semanticMap.fetched_assets ?? []), ...meta];

    await writeJson(METADATA_PATH, combinedMetadata);
    await writeJson(SEMANTIC_MAP_PATH, semanticMap);

    console.log(
      `[done] saved ${meta.length} assets. See ${path.relative(
        process.cwd(),
        METADATA_PATH
      )} and updated semantic_map.json`
    );
  } finally {
    await browser.close();
  }
}
