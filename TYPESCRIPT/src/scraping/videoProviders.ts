// src/scraping/videoProviders.ts
import type { Page, Browser } from "puppeteer";
import { scrollLazy, newPage } from "./browser";
import type { ScrapedItem } from "./imageProviders";

export async function scrapePixabayVideos(
  browser: Browser,
  q: string,
  limit: number
): Promise<ScrapedItem[]> {
  const page = await newPage(browser);
  const url = `https://pixabay.com/videos/search/${encodeURIComponent(q)}/`;
  await page.goto(url, { waitUntil: "networkidle2" });
  await scrollLazy(page);
  const items: ScrapedItem[] = [];

  const links = await page.$$eval("a[href*='/videos/']", (as, limitEval) => {
    return (as as HTMLAnchorElement[])
      .slice(0, limitEval * 4)
      .map((a) => a.href);
  }, limit);

  for (const href of links) {
    if (items.length >= limit) break;
    const detailPage = await newPage(browser);
    try {
      await detailPage.goto(href, { waitUntil: "networkidle2" });
      const src = await detailPage.$eval("video source[src]", (s: any) => s.src as string);
      if (src) {
        items.push({
          type: "video",
          source: "pixabay",
          mediaUrl: src,
          pageUrl: href,
          query: q,
        });
      }
    } catch (err) {
      console.warn("[pixabay_videos] error:", err);
    } finally {
      await detailPage.close();
    }
  }

  await page.close();
  return items;
}

export async function scrapePexelsVideos(
  browser: Browser,
  q: string,
  limit: number
): Promise<ScrapedItem[]> {
  const page = await newPage(browser);
  const url = `https://www.pexels.com/search/videos/${encodeURIComponent(q)}/`;
  await page.goto(url, { waitUntil: "networkidle2" });
  await scrollLazy(page);

  const items: ScrapedItem[] = [];

  const anchors = await page.$$eval(
    "a[href*='/video/']",
    (as, limitEval) => (as as HTMLAnchorElement[]).slice(0, limitEval * 4).map((a) => a.href),
    limit
  );

  for (const href of anchors) {
    if (items.length >= limit) break;
    const detailPage = await newPage(browser);
    try {
      await detailPage.goto(href, { waitUntil: "networkidle2" });
      const src = await detailPage.$eval("video", (v: any) => v.src as string);
      if (src) {
        items.push({
          type: "video",
          source: "pexels",
          mediaUrl: src,
          pageUrl: href,
          query: q,
        });
      }
    } catch (err) {
      console.warn("[pexels_videos] error:", err);
    } finally {
      await detailPage.close();
    }
  }

  await page.close();
  return items;
}
