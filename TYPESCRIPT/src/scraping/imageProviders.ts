// src/scraping/imageProviders.ts
import type { Page } from "puppeteer";
import { scrollLazy } from "./browser";

export interface ScrapedItem {
  type: "image" | "video" | "audio";
  source: string;
  mediaUrl: string;
  pageUrl?: string;
  alt?: string;
  query: string;
}

function chooseBestSrc(src: string | null, srcset: string | null): string {
  if (srcset) {
    try {
      const parts = srcset
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length > 0) {
        return parts[parts.length - 1].split(" ")[0];
      }
    } catch {
      // ignore
    }
  }
  return src ?? "";
}

export async function scrapeUnsplashImages(
  page: Page,
  q: string,
  limit: number
): Promise<ScrapedItem[]> {
  const url = `https://unsplash.com/s/photos/${q.replace(/\s+/g, "-")}`;
  await page.goto(url, { waitUntil: "networkidle2" });
  await scrollLazy(page);
  const items: ScrapedItem[] = [];

  const data = await page.evaluate((limitEval) => {
    const results: {
      src: string;
      alt: string;
      pageUrl: string;
    }[] = [];
    const imgs = Array.from(document.querySelectorAll("img"));
    const seen = new Set<string>();

    for (const img of imgs) {
      if (results.length >= limitEval) break;
      const el = img as HTMLImageElement;
      const src = el.src || "";
      const srcset = el.srcset || "";
      let best = src;
      if (srcset) {
        const parts = srcset
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
        if (parts.length > 0) {
          best = parts[parts.length - 1].split(" ")[0];
        }
      }
      if (!best) continue;
      if (!best.includes("images.unsplash.com")) continue;
      const key = best.split("?")[0];
      if (seen.has(key)) continue;
      seen.add(key);

      let pageUrl = "";
      const link = el.closest("a[href*='/photos/']") as HTMLAnchorElement | null;
      if (link) pageUrl = link.href;

      results.push({
        src: best,
        alt: el.alt || "",
        pageUrl,
      });
    }
    return results;
  }, limit);

  for (const d of data) {
    items.push({
      type: "image",
      source: "unsplash",
      mediaUrl: d.src,
      pageUrl: d.pageUrl,
      alt: d.alt,
      query: q,
    });
  }

  return items;
}

export async function scrapePexelsImages(
  page: Page,
  q: string,
  limit: number
): Promise<ScrapedItem[]> {
  const url = `https://www.pexels.com/search/${encodeURIComponent(q)}/`;
  await page.goto(url, { waitUntil: "networkidle2" });
  await scrollLazy(page);
  const items: ScrapedItem[] = [];

  const data = await page.evaluate((limitEval) => {
    const results: {
      src: string;
      alt: string;
      pageUrl: string;
    }[] = [];
    const imgs = Array.from(document.querySelectorAll("img"));
    const seen = new Set<string>();

    for (const img of imgs) {
      if (results.length >= limitEval) break;
      const el = img as HTMLImageElement;
      const rawSrc = el.getAttribute("src") || el.getAttribute("data-src") || "";
      const srcset = el.getAttribute("srcset") || "";
      let best = rawSrc;
      if (srcset) {
        const parts = srcset
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
        if (parts.length > 0) {
          best = parts[parts.length - 1].split(" ")[0];
        }
      }
      if (!best) continue;
      if (!best.includes("images.pexels.com")) continue;
      const key = best.split("?")[0];
      if (seen.has(key)) continue;
      seen.add(key);

      let pageUrl = "";
      const link = el.closest("a[href*='/photo/']") as HTMLAnchorElement | null;
      if (link) pageUrl = link.href;

      results.push({
        src: best,
        alt: el.alt || "",
        pageUrl,
      });
    }
    return results;
  }, limit);

  for (const d of data) {
    items.push({
      type: "image",
      source: "pexels",
      mediaUrl: d.src,
      pageUrl: d.pageUrl,
      alt: d.alt,
      query: q,
    });
  }

  return items;
}

export async function scrapePixabayImages(
  page: Page,
  q: string,
  limit: number
): Promise<ScrapedItem[]> {
  const url = `https://pixabay.com/images/search/${encodeURIComponent(q)}/`;
  await page.goto(url, { waitUntil: "networkidle2" });
  await scrollLazy(page);

  const data = await page.evaluate((limitEval) => {
    const results: {
      src: string;
      alt: string;
      pageUrl: string;
    }[] = [];
    const imgs = Array.from(document.querySelectorAll("img"));
    const seen = new Set<string>();

    for (const img of imgs) {
      if (results.length >= limitEval) break;
      const el = img as HTMLImageElement;
      const rawSrc = el.getAttribute("src") || el.getAttribute("data-lazy") || "";
      const srcset = el.getAttribute("srcset") || "";
      let best = rawSrc;
      if (srcset) {
        const parts = srcset
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
        if (parts.length > 0) {
          best = parts[parts.length - 1].split(" ")[0];
        }
      }
      if (!best) continue;
      if (!best.includes("pixabay.com")) continue;
      const key = best.split("?")[0];
      if (seen.has(key)) continue;
      seen.add(key);

      let pageUrl = "";
      const link = el.closest("a") as HTMLAnchorElement | null;
      if (link) pageUrl = link.href;

      results.push({
        src: best,
        alt: el.alt || "",
        pageUrl,
      });
    }
    return results;
  }, limit);

  return data.map((d) => ({
    type: "image" as const,
    source: "pixabay",
    mediaUrl: d.src,
    pageUrl: d.pageUrl,
    alt: d.alt,
    query: q,
  }));
}
