import readline from "readline";
import { runPromptUnderstanding } from "./pipeline/promptUnderstanding";
import { runDecisionReasoning } from "./pipeline/decisionReasoning";
import { runFetchAssets } from "./scraping/fetchAssets";
import { runGenerateWithFal } from "./generation/generateWithFal";
import { runRelevanceMatching } from "./pipeline/relevanceMatcher";
import { readJson } from "./utils/fileUtils";
import { SEMANTIC_MAP_PATH } from "./config/constants";
import type { SemanticMap } from "./types/semanticMap";
import { runAssetClassification } from "./pipeline/assetClassifier";
const mode = process.env.HELMER_MODE || "full";
const MAX_RETRIES = 2; // Total attempts = 3
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

/**
 * Orchestrator: Manages the agentic feedback loop
 */
async function runOrchestrator(initialPrompt: string) {
  let currentPrompt = initialPrompt;
  let attempts = 0;
  let satisfied = false;

  while (attempts <= MAX_RETRIES && !satisfied) {
    console.log(`\n🔄 --- AGENTIC LOOP: ATTEMPT ${attempts + 1} ---`);
    
    try {
      // 1. Prompt Understanding
      await runPromptUnderstanding(currentPrompt);

      // 2. Decision Reasoning
      await runDecisionReasoning();

      const semanticMap = (await readJson<SemanticMap>(SEMANTIC_MAP_PATH)) ?? ({} as SemanticMap);
      const decision = semanticMap.decision_reasoning?.final_decision ?? "";
      console.log("🧭 Final decision from reasoning module:", decision);

      // 3. Execution (Fetch / Generate)
      if (decision === "generate_with_model") {
        await runGenerateWithFal();
      } else if (decision === "fetch_from_web" || decision === "hybrid_fetch_and_enhance") {
        await runFetchAssets();
        if (decision === "hybrid_fetch_and_enhance") await runGenerateWithFal();
      } else {
        await runFetchAssets();
      }
      // 4. Relevance Matching (The Evaluator)
      await runRelevanceMatching();

      //5. Classification Step
      await runAssetClassification();


      // 6. Feedback / Evaluation Step
      const updatedMap = (await readJson<SemanticMap>(SEMANTIC_MAP_PATH)) ?? ({} as SemanticMap);
      const relevantAssets = updatedMap.relevant_assets || [];
      
      // Satisfaction Criteria: At least 3 high-quality assets
      if (relevantAssets.length >= 3) {
        console.log(`✅ Satisfaction Met: Found ${relevantAssets.length} relevant assets.`);
        satisfied = true;
      } else {
        console.warn(`⚠️ Only found ${relevantAssets.length} assets. Refining prompt for retry...`);
        // Basic prompt refinement logic - in a real agent, use an LLM for "reflection"
        currentPrompt = `highly detailed cinematic professional stock ${initialPrompt}`;
        attempts++;
      }

    } catch (err) {
      console.error(`\n❌ Error during attempt ${attempts + 1}:`, err);
      attempts++; // Treat errors as a failed attempt to try again or exit
    }
  }

  if (!satisfied) {
    console.error("\n❌ Pipeline finished after max retries without meeting satisfaction.");
  } else {
    console.log("\n✨ Pipeline Finished Successfully.");
  }
}

async function main() {
  const cliPrompt = process.argv.slice(2).join(" ").trim();
  
  if (!cliPrompt) {
  const prompt = await askFromStdin("Enter prompt: ");
  await runOrchestrator(prompt);
  return;
}


  try {
    if (mode === "stage1") {
      console.log("🚀 Running Stage 1 + 2 (analysis only)...");
      await runPromptUnderstanding(cliPrompt);
      await runDecisionReasoning();
      return;
    }

    if (mode === "stage3_direct") {
      console.log("🚀 Running Stage 1 → 3 DIRECT EXECUTION...");

      await runPromptUnderstanding(cliPrompt);
      await runDecisionReasoning();

      const semanticMap = (await readJson<SemanticMap>(SEMANTIC_MAP_PATH)) ?? ({} as SemanticMap);
      const decision = semanticMap.decision_reasoning?.final_decision;

      console.log("🧭 Final decision:", decision);

      if (decision === "generate_with_model") {
        await runGenerateWithFal();
      } else if (decision === "fetch_from_web") {
        await runFetchAssets();
      } else if (decision === "hybrid_fetch_and_enhance") {
        await runFetchAssets();
        await runGenerateWithFal();
      } else {
        console.warn("⚠️ Unknown decision, defaulting to fetch.");
        await runFetchAssets();
      }

      console.log("✅ Stage 3 execution finished.");
      return;
    }

    // Default: Run the full orchestrator if no specific stage mode matches
    await runOrchestrator(cliPrompt);

  } catch (err) {
    console.error("❌ Error in main execution:", err);
    process.exit(1);
  } // <--- Added closing brace for try/catch
} // <--- Added closing brace for function// This check ensures main() only runs if the file is executed directly
if (require.main === module || !module.parent) {
    main().catch(err => {
        console.error("❌ Critical error during execution:", err);
        process.exit(1);
    });
}