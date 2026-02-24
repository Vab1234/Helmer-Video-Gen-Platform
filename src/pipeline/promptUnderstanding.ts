// src/pipeline/promptUnderstanding.ts

import path from "path";
import { askPromptEngine } from "../openai/askPromptEngine";
import { SEMANTIC_MAP_PATH } from "../config/constants";
import { writeJson } from "../utils/fileUtils";
import {
  SemanticMap,
  IntentExtraction,
  RealismScoring,
} from "../types/semanticMap";
import type { MediaType } from "../types/semanticMap";

function safeJsonParse<T>(raw: string, label: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.error(`Failed to parse JSON output for ${label}.`);
    console.error("Raw LLM response:", raw);
    return undefined;
  }
}

export async function runPromptUnderstanding(
  userPrompt: string,
  requestedCount?: number,
  requestedModality?: MediaType,
): Promise<SemanticMap> {
  const startTime = Date.now();

  console.log("\n--- PROMPT UNDERSTANDING MODULE ---");
  console.log("Input Prompt:", userPrompt);
  console.log("-----------------------------------");

  const unifiedPrompt = `
Perform structured Prompt Understanding.

User Prompt:
"${userPrompt}"

Internally reason step-by-step. Do NOT reveal reasoning.
Return ONLY valid JSON.

Tasks:

1) Intent Extraction
   - modality (image | video | audio)
   - domain
   - primary_subject
   - context_scene
   - style_adjectives (array)

2) Realism Scoring
   - realism_score (0–1)
   - abstractness_score (0–1)
   - short rationale

3) Market Availability
   - Estimate commonness in free stock libraries (0–1)

Schema:

{
  "intent_extraction": {
    "modality": "",
    "domain": "",
    "primary_subject": "",
    "context_scene": "",
    "style_adjectives": []
  },
  "realism_scoring": {
    "realism_score": 0.0,
    "abstractness_score": 0.0,
    "rationale": ""
  },
  "market_availability_estimate": 0.0
}
`.trim();

  const raw = await askPromptEngine(unifiedPrompt);

  // 🔥 PRINT RAW JSON FROM LLM
  console.log("\n--- RAW LLM RESPONSE ---");
  console.log(raw);
  console.log("------------------------\n");

  const parsed = safeJsonParse<{
    intent_extraction: IntentExtraction;
    realism_scoring: RealismScoring;
    market_availability_estimate: number;
  }>(raw, "prompt_understanding");

  const semanticMap: SemanticMap = {
    user_prompt: userPrompt,
    requested_asset_count: requestedCount,
    requested_modality: requestedModality,
    intent_extraction: parsed?.intent_extraction ?? {},
    realism_scoring: parsed?.realism_scoring ?? {},
    market_availability_estimate:
      parsed?.market_availability_estimate ?? 0.5,

  };

  // --- NEW: Metrics Calculation ---
  const endTime = Date.now();
  const latency = endTime - startTime;

  // Calculate Completeness: Count non-empty fields in Intent Extraction
  let filledFields = 0;
  const totalFields = 5; // modality, domain, subject, context, style
  const intent = semanticMap.intent_extraction || {};
  if (intent.modality) filledFields++;
  if (intent.domain) filledFields++;
  if (intent.primary_subject) filledFields++;
  if (intent.context_scene) filledFields++;
  if (intent.style_adjectives && intent.style_adjectives.length > 0) filledFields++;

  const completeness = filledFields / totalFields;

  // Initialize Evaluation Metrics
  semanticMap.evaluation_metrics = {
    timestamp: new Date().toISOString(),
    total_latency_ms: 0, // Will be updated at end (index.ts)
    system_health_score: 0,
    stage1: {
      latency_ms: latency,
      completeness_score: completeness,
      modality_confidence: 0.9, // Placeholder/Simulated
    },
  };

  await writeJson(SEMANTIC_MAP_PATH, semanticMap);

  console.log(
    `Semantic map saved to: ${path.relative(
      process.cwd(),
      SEMANTIC_MAP_PATH
    )}`
  );

  console.log("Parsed Semantic Map:");
  console.log(JSON.stringify(semanticMap, null, 2));

  console.log("Prompt understanding stage completed.\n");

  return semanticMap;
}