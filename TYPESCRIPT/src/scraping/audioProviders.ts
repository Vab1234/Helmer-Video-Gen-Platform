// src/scraping/audioProviders.ts
import type { Browser } from "puppeteer";
import { newPage, scrollLazy } from "./browser";
import type { ScrapedItem } from "./imageProviders";

export async function scrapeMixkitSounds(
  browser: Browser,
  q: string,
  limit: number
): Promise<ScrapedItem[]> {
  const page = await newPage(browser);
  const url = `https://mixkit.co/search/sound-effects/${encodeURIComponent(q)}/`;
  await page.goto(url, { waitUntil: "networkidle2" });
  await scrollLazy(page);

  const anchors = await page.$$eval(
    "a[href*='/free-sound/']",
    (as, limitEval) => (as as HTMLAnchorElement[]).slice(0, limitEval * 4).map((a) => a.href),
    limit
  );

  const items: ScrapedItem[] = [];

  for (const href of anchors) {
    if (items.length >= limit) break;
    const detail = await newPage(browser);
    try {
      await detail.goto(href, { waitUntil: "networkidle2" });
      const dl = await detail.$$eval(
        "a[href$='.wav'], a[href$='.mp3']",
        (as) => (as[0] as HTMLAnchorElement | undefined)?.href || ""
      );
      if (dl) {
        items.push({
          type: "audio",
          source: "mixkit",
          mediaUrl: dl,
          pageUrl: href,
          query: q,
        });
      }
    } catch (err) {
      console.warn("[mixkit_sounds] error:", err);
    } finally {
      await detail.close();
    }
  }

  await page.close();
  return items;
}
