// src/scraping/browser.ts
import puppeteer, { Browser, Page } from "puppeteer";
import { HEADLESS, USER_AGENT } from "../config/constants";

export async function createBrowser(): Promise<Browser> {
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      `--user-agent=${USER_AGENT}`,
    ],
  });

  return browser;
}

export async function newPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  page.setDefaultNavigationTimeout(60000);
  return page;
}

// Simple sleep helper using setTimeout
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function scrollLazy(
  page: Page,
  pause = 1300,
  maxScrolls = 35
): Promise<void> {
  let lastHeight = (await page.evaluate(
    "document.body.scrollHeight"
  )) as number;

  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight);");
    await sleep(pause);

    const newHeight = (await page.evaluate(
      "document.body.scrollHeight"
    )) as number;

    if (newHeight === lastHeight) {
      await sleep(pause);
      const newHeight2 = (await page.evaluate(
        "document.body.scrollHeight"
      )) as number;
      if (newHeight2 === lastHeight) break;
    }

    lastHeight = newHeight;
  }
}
