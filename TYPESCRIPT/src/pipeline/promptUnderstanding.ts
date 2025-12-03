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

export async function runPromptUnderstanding(userPrompt: string): Promise<SemanticMap> {
  console.log("🧠 PROMPT UNDERSTANDING MODULE");
  console.log("User prompt:", userPrompt);
  console.log("====================================");

  // ==============
  // STEP 1: Intent Extraction
  // ==============
  const intentPrompt = `
You are an AI system analyzing a creative prompt for intent and structure.

Prompt: "${userPrompt}"

Perform Intent Extraction with these substeps:
1. **Modality** — image, video, audio   
2. **Domain** — natural, artistic, conceptual, surreal, etc.
3. **Primary Subject** — the main focus entity.
4. **Context / Scene** — environment or setting.
5. **Style Adjectives** — mood or tone modifiers (e.g. cinematic, slow-motion, dreamy).

Return a JSON object exactly in this format:
{
  "modality": "",
  "domain": "",
  "primary_subject": "",
  "context_scene": "",
  "style_adjectives": []
}
`.trim();

  const intentRaw = await askPromptEngine(intentPrompt);
  console.log("🔍 Intent Extraction Result:\n", intentRaw);

  const intentData =
    safeJsonParse<IntentExtraction>(intentRaw, "intent_extraction") ?? {};

  // ==============
  // STEP 2: Realism & Abstractness Scoring
  // ==============
  const scorePrompt = `
You are a cognitive model that evaluates the realism and abstractness of a visual prompt.

Use the following extracted intent:
${JSON.stringify(intentData, null, 2)}

Perform analysis based on these three information sources:
1. Subject–Context Relationship: how plausible is the subject existing in this context?
2. Modifiers: do adjectives or style words (like "glowing", "ethereal", "cinematic") add creative abstraction?
3. Domain Knowledge: using world understanding, judge how realistic this concept would be.

From this reasoning, generate TWO quantitative scores between 0.0 and 1.0:
- realism_score: higher means physically and contextually plausible.
- abstractness_score: higher means more imaginative, conceptual, or surreal.

Also provide a short rationale describing your reasoning.

Return ONLY valid JSON in the format:
{
  "realism_score": 0.0,
  "abstractness_score": 0.0,
  "rationale": "concise explanation summarizing how subject-context, modifiers, and domain knowledge influenced the scores."
}
`.trim();

  const scoresRaw = await askPromptEngine(scorePrompt);
  console.log("\n🎯 Realism & Abstractness Scoring:\n", scoresRaw);

  const scoreData =
    safeJsonParse<RealismScoring>(scoresRaw, "realism_scoring") ?? {};

  // ==============
  // STEP 3: Feasibility Judgement
  // ==============
  const feasibilityPrompt = `
Now, using your world knowledge, make an overall feasibility judgement.

Given:
Intent: ${JSON.stringify(intentData, null, 2)}
Scores: ${JSON.stringify(scoreData, null, 2)}

Evaluate:
- Is this scenario physically plausible?
- Would an image/video generator find real reference material for this?
- How realistic vs. creative is this concept overall?

Return a JSON with:
{
  "feasibility_label": "feasible / partially_feasible / fantasy",
  "realism_overall_score": 0.0,
  "creative_potential_score": 0.0,
  "summary": "short explanation"
}
`.trim();

  const feasibilityRaw = await askPromptEngine(feasibilityPrompt);
  console.log("\n🌐 Feasibility Judgement:\n", feasibilityRaw);

  const feasibilityData =
    safeJsonParse<FeasibilityJudgement>(feasibilityRaw, "feasibility_judgement") ??
    {};

  // ==============
  // STEP 4: Semantic Map Assembly
  // ==============
  const semanticMap: SemanticMap = {
    user_prompt: userPrompt,
    intent_extraction: intentData,
    realism_scoring: scoreData,
    feasibility_judgement: feasibilityData,
  };

  console.log("\n🗺️ Semantic Map:\n");
  console.log(JSON.stringify(semanticMap, null, 2));

  // Save for later steps
  await writeJson(SEMANTIC_MAP_PATH, semanticMap);

  console.log(
    `\n'Semantic map saved to: ${path.relative(
      process.cwd(),
      SEMANTIC_MAP_PATH
    )}'`
  );
  console.log("This file will be used in next pipeline steps.\n");

  return semanticMap;
}
