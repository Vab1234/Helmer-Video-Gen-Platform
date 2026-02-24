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
import { refineUserPrompt } from "./pipeline/promptRefiner";
import type { MediaType } from "./types/semanticMap";


import { logBenchmark } from "./utils/benchmarkLogger";
import { writeJson } from "./utils/fileUtils";
const mode = process.env.HELMER_MODE || "full";
const MAX_RETRIES = 2; // Total attempts = 3

/**
 * Orchestrator: Controls the agentic execution loop
 */
async function runOrchestrator(initialPrompt: string, requestedCount?: number,
  requestedModality?: "image" | "video" | "audio") {
  let currentPrompt = initialPrompt;
  let attempts = 0;
  let satisfied = false;

  while (attempts <= MAX_RETRIES && !satisfied) {
    console.log(`\n--- AGENTIC LOOP | Attempt ${attempts + 1} ---`);

    try {
      await runPromptUnderstanding(currentPrompt, requestedCount, requestedModality);
      await runDecisionReasoning(attempts + 1);

      const semanticMap =
        (await readJson<SemanticMap>(SEMANTIC_MAP_PATH)) ??
        ({} as SemanticMap);

      const decision =
        semanticMap.decision_reasoning?.final_decision ?? "";

      console.log("Decision:", decision);

      // Execution phase
      if (decision === "generate_with_model") {
        await runGenerateWithFal();
      } else if (
        decision === "fetch_from_web" ||
        decision === "hybrid_fetch_and_enhance"
      ) {
        await runFetchAssets();
        if (decision === "hybrid_fetch_and_enhance") {
          await runGenerateWithFal();
        }
      } else {
        await runFetchAssets();
      }

      await runRelevanceMatching();
      await runAssetClassification();

      const updatedMap =
        (await readJson<SemanticMap>(SEMANTIC_MAP_PATH)) ??
        ({} as SemanticMap);

      const relevantAssets = updatedMap.relevant_assets || [];

      // Satisfaction criteria
      if (relevantAssets.length >= 3) {
        console.log(
          `Success: ${relevantAssets.length} relevant assets identified.`
        );
        satisfied = true;
      } else {
        console.warn(
          `Only ${relevantAssets.length} relevant assets found. Refining prompt and retrying...`
        );
        currentPrompt = `highly detailed cinematic professional stock ${initialPrompt}`;
        attempts++;
      }
    } catch (error) {
      console.error(
        `Execution error during attempt ${attempts + 1}:`,
        error
      );
      attempts++;
    }
  }

  if (!satisfied) {
    console.error(
      "Execution completed. Satisfaction criteria not met within retry limit."
    );
  } else {
    // --- NEW: Finalize Metrics & Log ---
    try {
      const finalMap = (await readJson<SemanticMap>(SEMANTIC_MAP_PATH));
      if (finalMap && finalMap.evaluation_metrics) {
        const metrics = finalMap.evaluation_metrics;
        // 1. Total Latency (simplified, just summing stages for now or diff from start)
        // Ideally we tracked start time of runOrchestrator, but summing stages is safer for async gaps
        const totalLat = (metrics.stage1?.latency_ms || 0) +
          (metrics.stage2?.latency_ms || 0) +
          (metrics.stage3?.latency_ms || 0) +
          (metrics.stage4?.latency_ms || 0);

        metrics.total_latency_ms = totalLat;

        // 2. System Health Score (Weighted)
        // S1 (Completeness) * 0.2 + S2 (Confidence) * 0.2 + S4 (Precision) * 0.6
        const s1Score = metrics.stage1?.completeness_score || 0;
        const s2Score = metrics.stage2?.decision_confidence || 0;
        const s4Score = metrics.stage4?.precision_at_k || 0;

        metrics.system_health_score = (s1Score * 0.2) + (s2Score * 0.2) + (s4Score * 0.6);

        await writeJson(SEMANTIC_MAP_PATH, finalMap);

        // 3. Log to CSV
        logBenchmark(finalMap);

        console.log("\n📊 EXPERIMENT METRICS LOGGED");
        console.log(`   Total Latency: ${totalLat}ms`);
        console.log(`   Health Score:  ${metrics.system_health_score.toFixed(2)}`);
      }
    } catch (e) {
      console.error("Failed to log metrics:", e);
    }

    console.log("Pipeline completed successfully.");
  }
}

/**
 * Validates that mandatory prompt fields exist
 */

function askFromStdin(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}



async function main() {
  console.log("Helmer Pipeline Initializing...");

  let cliPrompt = process.argv.slice(2).join(" ").trim();

  if (!cliPrompt) {
    cliPrompt = await askFromStdin("Enter prompt: ");
  }

  if (!cliPrompt) {
    console.error("No prompt provided. Terminating execution.");
    return;
  }

  let isReady = false;
  let currentPrompt = cliPrompt;

  let requestedCount: number | undefined;
  let requestedModality: MediaType | undefined;

  // Intelligent refinement loop
  while (!isReady) {
    const refinement = await refineUserPrompt(currentPrompt);

    if (refinement.isComplete) {
      isReady = true;
      cliPrompt = refinement.refinedPrompt;

      requestedCount = refinement.count ?? 1;
      requestedModality = refinement.modality;

      console.log("\n--- USER REQUEST SUMMARY ---");
      console.log("Modality:", requestedModality);
      console.log("Requested Count:", requestedCount);
      console.log("-----------------------------\n");

    } else {
      console.log(`\nHELMER: ${refinement.message}`);
      const supplementaryInfo = await askFromStdin("Your response: ");
      currentPrompt = `${currentPrompt} ${supplementaryInfo}`.trim();
    }
  }

  try {
    if (mode === "stage1") {
      await runPromptUnderstanding(cliPrompt, requestedCount, requestedModality);
      await runDecisionReasoning();
    } else {
      await runOrchestrator(cliPrompt, requestedCount, requestedModality);
    }
  } catch (error) {
    console.error("Fatal execution error:", error);
    process.exit(1);
  }
}
main().catch((error) => {
  console.error("Critical failure:", error);
  process.exit(1);
});
