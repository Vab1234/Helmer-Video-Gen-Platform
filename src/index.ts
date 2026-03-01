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
import type { MediaType, MediaContext } from "./types/semanticMap";
import { analyseUserMedia } from "./pipeline/mediaUnderstanding";  // ← NEW

import { logBenchmark } from "./utils/benchmarkLogger";
import { writeJson } from "./utils/fileUtils";
const mode = process.env.HELMER_MODE || "full";
const MAX_RETRIES = 2; // Total attempts = 3

/**
 * Orchestrator: Controls the agentic execution loop
 */
async function runOrchestrator(
  initialPrompt: string,
  requestedCount?: number,
  requestedModality?: "image" | "video" | "audio",
  mediaContext?: MediaContext,          // ← NEW optional param
) {
  let currentPrompt = initialPrompt;
  let attempts = 0;
  let satisfied = false;

  // When the user media role is "transform" or "style_guide" the output is
  // a direct model generation conditioned on the uploaded file — retrying
  // with a mangled prompt makes no sense and wastes API calls.
  // We also lower the satisfaction bar to 1 asset (not 3) because we are
  // transforming a specific image, not curating a catalogue of results.
  const isMediaTransform =
    mediaContext !== undefined &&
    (mediaContext as any).role !== undefined
      ? ["transform", "style_guide"].includes((mediaContext as any).role)
      : false;

  // We can't know the role until Stage 1 has run, so we check the semantic
  // map after the first pass and gate retries on it.
  const shouldSkipRetry = (): boolean => false; // evaluated after first run below

  while (attempts <= MAX_RETRIES && !satisfied) {
    console.log(`\n--- AGENTIC LOOP | Attempt ${attempts + 1} ---`);

    try {
      // Pass mediaContext into Stage 1 — undefined when no file was provided
      await runPromptUnderstanding(currentPrompt, requestedCount, requestedModality, mediaContext);
      await runDecisionReasoning(attempts + 1);

      const semanticMap =
        (await readJson<SemanticMap>(SEMANTIC_MAP_PATH)) ??
        ({} as SemanticMap);

      const decision =
        semanticMap.decision_reasoning?.final_decision ?? "";

      // Resolve the media role NOW that Stage 1 has written it to the map
      const resolvedRole = semanticMap.user_media?.role;
      const isTransformRun =
        resolvedRole === "transform" || resolvedRole === "style_guide";

      // Satisfaction threshold: 1 for directed transforms, 3 for open searches
      const satisfactionThreshold = isTransformRun ? 1 : 3;

      console.log("Decision:", decision);
      if (isTransformRun) {
        console.log(`[orchestrator] Transform run detected (role: "${resolvedRole}") — satisfaction threshold set to 1, retries disabled.`);
      }

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
      if (relevantAssets.length >= satisfactionThreshold) {
        console.log(
          `Success: ${relevantAssets.length} relevant assets identified.`
        );
        satisfied = true;
      } else if (isTransformRun) {
        // For transforms, don't retry — the generation ran correctly.
        // 0 relevant assets means the relevance scorer filtered them out,
        // not that the generation failed. Accept the output and finish.
        console.warn(
          `[orchestrator] Relevance matcher filtered all transform assets ` +
          `(CLIP threshold may be too strict for img2img output). ` +
          `Accepting generated assets and completing.`
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
        const totalLat = (metrics.stage1?.latency_ms || 0) +
          (metrics.stage2?.latency_ms || 0) +
          (metrics.stage3?.latency_ms || 0) +
          (metrics.stage4?.latency_ms || 0);

        metrics.total_latency_ms = totalLat;

        const s1Score = metrics.stage1?.completeness_score || 0;
        const s2Score = metrics.stage2?.decision_confidence || 0;
        const s4Score = metrics.stage4?.precision_at_k || 0;

        metrics.system_health_score = (s1Score * 0.2) + (s2Score * 0.2) + (s4Score * 0.6);

        await writeJson(SEMANTIC_MAP_PATH, finalMap);

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

  // ── CLI argument parsing ───────────────────────────────────────────────────
  // Usage:
  //   npx ts-node src/index.ts "your prompt"
  //   npx ts-node src/index.ts "your prompt" --media /path/to/file.jpg
  const rawArgs   = process.argv.slice(2);
  const mediaFlag = rawArgs.indexOf("--media");

  let userMediaPath: string | undefined;
  let promptArgs: string[];

  if (mediaFlag !== -1) {
    // --media flag found — next arg is the file path, rest is the prompt
    userMediaPath = rawArgs[mediaFlag + 1];
    promptArgs    = rawArgs.filter((_, i) => i !== mediaFlag && i !== mediaFlag + 1);
  } else {
    promptArgs = rawArgs;
  }

  let cliPrompt = promptArgs.join(" ").trim();

  if (!cliPrompt) {
    cliPrompt = await askFromStdin("Enter prompt: ");
  }

  if (!cliPrompt) {
    console.error("No prompt provided. Terminating execution.");
    return;
  }

  // ── Stage 0: Media Understanding (only when --media was passed) ───────────
  let mediaContext: MediaContext | undefined;

  if (userMediaPath) {
    console.log(`\n--- STAGE 0: MEDIA UNDERSTANDING ---`);
    console.log(`Media file: ${userMediaPath}`);
    console.log(`------------------------------------`);
    try {
      mediaContext = await analyseUserMedia(userMediaPath);
      console.log("[Stage 0] Media context resolved:");
      console.log(`  Modality   : ${mediaContext.modality}`);
      console.log(`  Description: ${mediaContext.description.slice(0, 120)}…`);
      console.log(`  Tags       : ${mediaContext.tags.join(", ")}`);
      if (mediaContext.transcription) {
        console.log(`  Transcription: "${mediaContext.transcription.slice(0, 80)}…"`);
      }
      console.log("------------------------------------\n");
    } catch (err) {
      console.error("[Stage 0] Media analysis failed — continuing without media context:", err);
      // Non-fatal: pipeline proceeds as prompt-only run
    }
  }

  // ── Prompt refinement loop (unchanged) ────────────────────────────────────
  let isReady = false;
  let currentPrompt = cliPrompt;

  let requestedCount: number | undefined;
  let requestedModality: MediaType | undefined;

  while (!isReady) {
    const refinement = await refineUserPrompt(currentPrompt);

    if (refinement.isComplete) {
      isReady = true;

      // When user media is present, the refiner rewrites the prompt into a
      // generic search query (e.g. "A rainy landscape scene...") which strips
      // the transformation intent. Stage 1 then picks "reference" instead of
      // "transform" and the pipeline fetches instead of running img2img.
      // Fix: keep the original raw user instruction as the lead so Stage 1
      // always sees the direct edit request alongside the refiner context.
      if (mediaContext) {
        cliPrompt = `${cliPrompt} [user instruction: ${refinement.refinedPrompt}]`;
      } else {
        cliPrompt = refinement.refinedPrompt;
      }

      requestedCount    = refinement.count ?? 1;
      requestedModality = refinement.modality;

      console.log("\n--- USER REQUEST SUMMARY ---");
      console.log("Modality:", requestedModality);
      console.log("Requested Count:", requestedCount);
      if (mediaContext) {
        console.log("Media Input:", `[${mediaContext.modality}] ${mediaContext.description.slice(0, 60)}…`);
      }
      console.log("-----------------------------\n");

    } else {
      console.log(`\nHELMER: ${refinement.message}`);
      const supplementaryInfo = await askFromStdin("Your response: ");
      currentPrompt = `${currentPrompt} ${supplementaryInfo}`.trim();
    }
  }

  // ── Run pipeline ──────────────────────────────────────────────────────────
  try {
    if (mode === "stage1") {
      await runPromptUnderstanding(cliPrompt, requestedCount, requestedModality, mediaContext);
      await runDecisionReasoning();
    } else {
      await runOrchestrator(cliPrompt, requestedCount, requestedModality, mediaContext);
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