import axios from "axios";
import { FREESOUND_API_KEY } from "../config/env";
import { ScrapedItem } from "./imageProviders";

const BASE_URL = "https://freesound.org/apiv2";

interface FreesoundResult {
  id: number;
  name: string;
  previews: { "preview-hq-mp3": string; "preview-hq-ogg": string };
  username: string;
  url: string; // page url
}

export async function scrapeFreesoundAudio(
  query: string,
  limit: number
): Promise<ScrapedItem[]> {
  if (!FREESOUND_API_KEY) {
    return [];
  }

  const items: ScrapedItem[] = [];
  const searchUrl = `${BASE_URL}/search/text/`;

  try {
    const params = {
      query: query,
      token: FREESOUND_API_KEY,
      fields: "id,name,previews,username,url",
      page_size: limit,
      filter: "duration:[1 TO 60]",
      sort: "score",
    };

    const res = await axios.get(searchUrl, { params, timeout: 10000 });
    const results = res.data.results as FreesoundResult[];

    if (results) {
      for (const r of results) {
        const mp3 = r.previews["preview-hq-mp3"];
        if (!mp3) continue;

        items.push({
          type: "audio",
          source: "freesound",
          mediaUrl: mp3,
          pageUrl: r.url,
          alt: r.name,
          query: query,
        });
      }
    }
  } catch (err: any) {
    console.warn(`[freesound] Error searching for '${query}':`, err.message);
  }

  return items;
}