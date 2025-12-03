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
  } catch (err) {
    console.error(`⚠️ Error decoding JSON for ${label}:`, err);
    console.error("Raw output:", raw);
    return undefined;
  }
}

export async function runDecisionReasoning(): Promise<SemanticMap> {
  console.log("==================================================");
  console.log("🧩 DECISION REASONING MODULE (Step 2)");
  console.log("==================================================");

  const semanticMap =
    (await readJson<SemanticMap>(SEMANTIC_MAP_PATH)) ?? ({} as SemanticMap);

  if (!semanticMap.user_prompt) {
    throw new Error(
      `No semantic map found at ${SEMANTIC_MAP_PATH}. Run prompt understanding first.`
    );
  }

  const decisionPrompt = `
You are performing *Decision Reasoning* based on the following semantic map:

${JSON.stringify(semanticMap, null, 2)}

Your task:

1. **Perform contextual reasoning**:
   - Examine the realism_score and abstractness_score.
   - Consider the feasibility_label and creative_potential_score.
   - Think step-by-step about what kind of media retrieval makes sense.

2. **Estimate Cost and Latency**:
   Estimate the computational cost and time latency for both options:
   - Fetch (search or retrieve real media)
   - Generate (create synthetic image/video)
   Classify each as: "low", "medium", or "high" cost and latency.

3. **Decide Fetch vs Generate**:
   Based on your reasoning, choose ONE of:
   - "fetch_from_web"
   - "generate_with_model"
   - "hybrid_fetch_and_enhance"

4. Return the result as JSON in this format:
{
  "reasoning_trace": "Your short reasoning chain-of-thought (natural language, concise).",
  "cost_latency_estimate": {
      "fetch": {"cost": "", "latency": ""},
      "generate": {"cost": "", "latency": ""}
  },
  "final_decision": "",
  "confidence": 0.0
}
`.trim();

  const raw = await askDecisionEngine(decisionPrompt);
  console.log("\n🧠 Decision Reasoning Raw Output:\n", raw);

  const decisionData =
    safeJsonParse<DecisionReasoning>(raw, "decision_reasoning") ?? {};

  const updated: SemanticMap = {
    ...semanticMap,
    decision_reasoning: decisionData,
  };

  console.log("\n🧠 Decision Reasoning Summary:");
  console.log(JSON.stringify(decisionData, null, 2));

  await writeJson(SEMANTIC_MAP_PATH, updated);
  console.log(
    `\n✅ Updated semantic_map.json saved with decision reasoning results at ${SEMANTIC_MAP_PATH}`
  );

  return updated;
}
