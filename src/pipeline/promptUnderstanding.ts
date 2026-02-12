// src/pipeline/promptUnderstanding.ts
import path from "path";
import { askPromptEngine } from "../openai/askPromptEngine";
import { SEMANTIC_MAP_PATH } from "../config/constants";
import { writeJson } from "../utils/fileUtils";
import {
  SemanticMap,
  IntentExtraction,
  RealismScoring,
  FeasibilityJudgement,
} from "../types/semanticMap";

function safeJsonParse<T>(raw: string, label: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(`⚠️ Error decoding JSON for ${label}:`, err);
    console.error("Raw output:", raw);
    return undefined;
  }
}

export async function runPromptUnderstanding(
  userPrompt: string
): Promise<SemanticMap> {
  console.log("🧠 PROMPT UNDERSTANDING MODULE");
  console.log("User prompt:", userPrompt);
  console.log("====================================");

  const unifiedPrompt = `
You are performing **Prompt Understanding** in ONE pass.

User Prompt:
"${userPrompt}"

Your tasks (do them internally, step by step):

1. **Intent Extraction**
   - modality
   - domain
   - primary_subject
   - context_scene
   - style_adjectives

2. **Realism & Abstractness Scoring**
   - realism_score (0.0–1.0)
   - abstractness_score (0.0–1.0)
   - rationale

3. **Feasibility Judgement**
   - feasibility_label (feasible / partially_feasible / fantasy)
   - realism_overall_score (0.0–1.0)
   - creative_potential_score (0.0–1.0)
   - summary

⚠️ IMPORTANT:
- Think carefully but DO NOT expose chain-of-thought.
- Return ONLY valid JSON.
- Match this EXACT schema:

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
  "feasibility_judgement": {
    "feasibility_label": "",
    "realism_overall_score": 0.0,
    "creative_potential_score": 0.0,
    "summary": ""
  }
}
`.trim();

  // 🔒 SINGLE LLM CALL
  const raw = await askPromptEngine(unifiedPrompt);
  console.log("\n🧠 Prompt Understanding Raw Output:\n", raw);

  const parsed = safeJsonParse<{
  intent_extraction: IntentExtraction;
  realism_scoring: RealismScoring;
  feasibility_judgement: FeasibilityJudgement;
  }>(raw, "prompt_understanding");


  const semanticMap: SemanticMap = {
  user_prompt: userPrompt,
  intent_extraction: parsed?.intent_extraction ?? {},
  realism_scoring: parsed?.realism_scoring ?? {},
  feasibility_judgement: parsed?.feasibility_judgement ?? {},
};


  console.log("\n🗺️ Semantic Map:\n");
  console.log(JSON.stringify(semanticMap, null, 2));

  await writeJson(SEMANTIC_MAP_PATH, semanticMap);

  console.log(
    `\n✅ Semantic map saved to: ${path.relative(
      process.cwd(),
      SEMANTIC_MAP_PATH
    )}`
  );
  console.log("This file will be used in next pipeline steps.\n");

  return semanticMap;
}
