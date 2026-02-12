// src/openai/queryBuilder.ts
import { openaiClient } from "../openai/client";
import { MAX_QUERIES } from "../config/constants";
import type { SemanticMap, MediaType } from "../types/semanticMap";

interface QueryResult {
  queries: string[];
}

function modalityGuidance(modality: MediaType): string {
  if (modality === "image") {
    return "Use photographic cues: subject, action/pose, lighting (golden hour, night), genre (street, portrait), framing (portrait, landscape, closeup).";
  }
  if (modality === "video") {
    return "Use short cinematic stock terms: subject + action, environment, mood. Avoid full sentences. Keep 2–5 words (e.g., 'city time-lapse night', 'woman dancing studio').";
  }
  return "Use sound effect terms: 'rain ambience', 'footsteps concrete', 'crowd cheer arena', 'keyboard typing', 'thunder clap', 'ocean waves'. 2–4 words.";
}

function buildQueryPrompt(
  semanticMap: SemanticMap,
  modality: MediaType,
  n: number
): string {
  const example = `{"queries": ["girl dancing portrait golden hour", "woman dancing street candid"]}`;
  return `
You convert semantic intent into short search phrases for stock sites.

Input semantic_map:
${JSON.stringify(semanticMap, null, 2)}

Modality: ${modality}

Goal: Output up to ${n} concise phrases (2–6 words) optimized for real searchable results on public stock sites
for this modality. Avoid punctuation and long sentences. Lowercase is fine. ${modalityGuidance(modality)}

Return EXACTLY one JSON object with key "queries".

Example format:
${example}
`.trim();
}

function heuristicFallback(semanticMap: SemanticMap, modality: MediaType): QueryResult {
  const intent = semanticMap.intent_extraction ?? {};
  const subj = (intent.primary_subject ?? "").split(" ").slice(0, 3).join(" ");
  const ctx = (intent.context_scene ?? "").split(" ").slice(0, 3).join(" ");

  let seeds: string[] = [];
  if (modality === "image") {
    seeds = [
      `${subj} ${ctx} portrait`.trim(),
      `${subj} ${ctx} golden hour`.trim(),
    ];
  } else if (modality === "video") {
    seeds = [
      `${subj} ${ctx} timelapse`.trim(),
      `${subj} ${ctx} b-roll`.trim(),
    ];
  } else {
    seeds = [`${subj} ambience`.trim(), `${subj} foley`.trim()];
  }

  return {
    queries: seeds.filter((s) => s).slice(0, MAX_QUERIES),
  };
}

export async function buildSearchQueries(
  semanticMap: SemanticMap,
  modality: MediaType
): Promise<QueryResult> {
  const prompt = buildQueryPrompt(semanticMap, modality, MAX_QUERIES);

  try {
    const resp = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You generate short stock-search phrases." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 300,
    });

    const txt = resp.choices[0]?.message?.content?.trim() ?? "";
    try {
      return JSON.parse(txt) as QueryResult;
    } catch {
      const match = txt.match(/(\{[\s\S]*"queries"\s*:\s*\[[\s\S]*?\][\s\S]*\})/);
      if (match) {
        return JSON.parse(match[1]) as QueryResult;
      }
      console.warn("[queryBuilder] Failed to parse LLM JSON, falling back to heuristic.");
      return heuristicFallback(semanticMap, modality);
    }
  } catch (err) {
    console.error("[queryBuilder] Error calling OpenAI:", err);
    return heuristicFallback(semanticMap, modality);
  }
}
