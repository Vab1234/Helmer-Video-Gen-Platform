import { runPromptUnderstanding } from "./promptUnderstanding";
import { runDecisionReasoning } from "./decisionReasoning";
import { runFetchAssets } from "../scraping/fetchAssets";
import { runRelevanceMatching } from "./relevanceMatcher";
import { readJson, writeJson } from "../utils/fileUtils";
import { SEMANTIC_MAP_PATH } from "../config/constants";
import type { SemanticMap } from "../types/semanticMap";

const MAX_RETRIES = 2; // Avoid infinite loops

export async function runAgenticWorkflow(initialPrompt: string): Promise<void> {
    let currentPrompt = initialPrompt;
    let attempts = 0;
    let satisfied = false;

    while (attempts <= MAX_RETRIES && !satisfied) {
        console.log(`\n🔄 --- AGENTIC LOOP: ATTEMPT ${attempts + 1} ---`);
        
        // 1. Core Pipeline
        await runPromptUnderstanding(currentPrompt);
        await runDecisionReasoning();
        await runFetchAssets();
        await runRelevanceMatching();

        // 2. Evaluation Step
        const semanticMap = await readJson<SemanticMap>(SEMANTIC_MAP_PATH);
        const relevantCount = semanticMap?.relevant_assets?.length || 0;

        // Condition for satisfaction: e.g., at least 3 high-quality assets
        if (relevantCount >= 3) {
            console.log(`✅ Satisfaction Met: Found ${relevantCount} relevant assets.`);
            satisfied = true;
        } else {
            console.warn(`⚠️ Only found ${relevantCount} assets. Refiing search...`);
            attempts++;
            
            // FEEDBACK MECHANISM: Refine the prompt for the next loop
            // In a real agent, you might use an LLM here to "Reflect" on why it failed
            currentPrompt = `high quality detailed cinematic footage of ${initialPrompt}, professional stock style`;
        }
    }

    if (!satisfied) {
        console.error("❌ Pipeline finished without meeting satisfaction criteria.");
    }
}