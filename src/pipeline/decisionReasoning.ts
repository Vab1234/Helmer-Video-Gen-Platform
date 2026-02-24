// src/pipeline/decisionReasoning.ts

import { readJson, writeJson } from "../utils/fileUtils";
import { SEMANTIC_MAP_PATH } from "../config/constants";
import type {
  SemanticMap,
  DecisionReasoning,
} from "../types/semanticMap";
import { askDecisionEngine } from "../openai/askDecisionEngine";

function safeJsonParse<T>(raw: string, label: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.error(`Failed to parse JSON output for ${label}.`);
    console.error("Raw LLM response:", raw);
    return undefined;
  }
}

export async function runDecisionReasoning(
  attemptNumber = 1
): Promise<SemanticMap> {

  console.log("\n--- DECISION REASONING MODULE ---");

  const semanticMap =
    (await readJson<SemanticMap>(SEMANTIC_MAP_PATH)) ??
    ({} as SemanticMap);

  if (!semanticMap.user_prompt) {
    throw new Error(
      `Semantic map not found at ${SEMANTIC_MAP_PATH}. Please run prompt understanding first.`
    );
  }

  const previousResults = semanticMap.relevant_assets?.length ?? 0;
  const realism =
    semanticMap.realism_scoring?.realism_score ?? 0.5;
  const scarcity =
    semanticMap.market_availability_estimate ?? 0.5;

  // -----------------------------------
  // 🚨 HARD OVERRIDES (NO LLM)
  // -----------------------------------

  // Retry override
  if (attemptNumber > 1 && previousResults === 0) {
    console.log("Retry with zero results → forcing generation.");

    semanticMap.decision_reasoning = {
      reasoning_trace:
        "Previous attempt returned zero results. Forcing generation.",
      final_decision: "generate_with_model",
      confidence: 0.95,
    };

    await writeJson(SEMANTIC_MAP_PATH, semanticMap);
    return semanticMap;
  }

  // Scarcity override
  if (scarcity < 0.3) {
    console.log("Very rare content → generating.");

    semanticMap.decision_reasoning = {
      reasoning_trace:
        "Market availability extremely low. Generating synthetic media.",
      final_decision: "generate_with_model",
      confidence: 0.9,
    };

    await writeJson(SEMANTIC_MAP_PATH, semanticMap);
    return semanticMap;
  }

  // -----------------------------------
  // ⚡ HIGH-CONFIDENCE RULE ZONE
  // -----------------------------------

  // Obvious fetch case
  if (realism > 0.8 && scarcity > 0.7) {
    console.log("High realism + high availability → fetch.");

    semanticMap.decision_reasoning = {
      reasoning_trace:
        "High realism and high stock availability. Fetching from web.",
      final_decision: "fetch_from_web",
      confidence: 0.85,
    };

    await writeJson(SEMANTIC_MAP_PATH, semanticMap);
    return semanticMap;
  }

  // Obvious generate case
  if (realism < 0.3) {
    console.log("Low realism (fantasy/abstract) → generate.");

    semanticMap.decision_reasoning = {
      reasoning_trace:
        "Low realism indicates fantasy or abstract content. Generating.",
      final_decision: "generate_with_model",
      confidence: 0.85,
    };

    await writeJson(SEMANTIC_MAP_PATH, semanticMap);
    return semanticMap;
  }

  // -----------------------------------
  // 🤖 AMBIGUOUS ZONE → CALL LLM
  // -----------------------------------

  console.log("Ambiguous zone detected → calling LLM decision engine.");

  const decisionPrompt = `
You are performing Decision Reasoning based on this semantic map:

${JSON.stringify(semanticMap, null, 2)}

Consider:
- realism_score
- abstractness_score
- market_availability_estimate
- attempt number
- previous results

Choose ONE:
- "fetch_from_web"
- "generate_with_model"
- "hybrid_fetch_and_enhance"

Return valid JSON:
{
  "reasoning_trace": "",
  "final_decision": "",
  "confidence": 0.0
}
`.trim();

  const raw = await askDecisionEngine(decisionPrompt);

  const decisionData =
    safeJsonParse<DecisionReasoning>(raw, "decision_reasoning") ?? {
      reasoning_trace: "Fallback to hybrid due to parse failure.",
      final_decision: "hybrid_fetch_and_enhance",
      confidence: 0.6,
    };

  semanticMap.decision_reasoning = decisionData;

  await writeJson(SEMANTIC_MAP_PATH, semanticMap);

  console.log("LLM decision completed and saved.\n");

  return semanticMap;
}