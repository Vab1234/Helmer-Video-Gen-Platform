// src/index.ts
import readline from "readline";
import { runPromptUnderstanding } from "./pipeline/promptUnderstanding";
import { runDecisionReasoning } from "./pipeline/decisionReasoning";
import { runFetchAssets } from "./scraping/fetchAssets";
import { runGenerateWithFal } from "./generation/generateWithFal";
import { readJson } from "./utils/fileUtils";
import { SEMANTIC_MAP_PATH } from "./config/constants";
import type { SemanticMap } from "./types/semanticMap";

function askFromStdin(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const cliPrompt = process.argv.slice(2).join(" ").trim();
  const userPrompt =
    cliPrompt || (await askFromStdin("Enter your media generation prompt: "));

  if (!userPrompt) {
    console.error("No prompt provided. Exiting.");
    process.exit(1);
  }

  // Step 1: build semantic map
  await runPromptUnderstanding(userPrompt);

  // Step 2: decision reasoning
  await runDecisionReasoning();

  // Load semantic map to check the decision
  const semanticMap =
    (await readJson<SemanticMap>(SEMANTIC_MAP_PATH)) ?? ({} as SemanticMap);
  const decision = semanticMap.decision_reasoning?.final_decision ?? "";

  console.log("\n🧭 Final decision from reasoning module:", decision);

  // Step 3: act based on decision
  if (decision === "generate_with_model") {
    console.log("[pipeline] → Running Fal generation only.");
    await runGenerateWithFal();
  } else if (decision === "fetch_from_web") {
    console.log("[pipeline] → Running web fetch only.");
    await runFetchAssets();
  } else if (decision === "hybrid_fetch_and_enhance") {
    console.log("[pipeline] → Running BOTH fetch and generation (hybrid).");
    await runFetchAssets();
    await runGenerateWithFal();
  } else {
    console.warn(
      "[pipeline] Unknown final_decision, defaulting to web fetch behavior."
    );
    await runFetchAssets();
  }
}

main().catch((err) => {
  console.error("Unexpected error in main:", err);
  process.exit(1);
});
