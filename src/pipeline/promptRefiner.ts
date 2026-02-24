// src/pipeline/promptRefiner.ts

import { askPromptEngine } from "../openai/askPromptEngine";

type RefinementResult = {
  refinedPrompt: string;
  isComplete: boolean;
  modality?: "image" | "video" | "audio";
  count?: number;
  message?: string;
};

function detectMissingDetails(text: string): string[] {
  const lower = text.toLowerCase();
  const missing: string[] = [];

  // Check subject (very simple heuristic: at least one noun-like word)
  if (lower.split(" ").length < 2) {
    missing.push("main subject");
  }

  // Action detection (simple verb heuristic)
  if (!/\b(working|running|typing|walking|talking|flying|playing|sitting|standing)\b/.test(lower)) {
    missing.push("action (what is happening)");
  }

  // Scene/context
  if (!/\b(in|on|at|inside|outdoor|beach|office|city|room|forest|studio)\b/.test(lower)) {
    missing.push("scene or location");
  }

  return missing;
}
function normalizeInput(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

function detectModality(text: string): "image" | "video" | "audio" | null {
  const lower = text.toLowerCase();

  if (/\b(image|images|photo|photos|picture|pictures)\b/.test(lower)) {
    return "image";
  }
  if (/\b(video|videos|footage|clip|clips)\b/.test(lower)) {
    return "video";
  }
  if (/\b(audio|sound|music|track|voiceover)\b/.test(lower)) {
    return "audio";
  }

  return null;
}

function detectCount(text: string): number | null {
  const match = text.match(/\b\d+\b/);
  if (match) {
    return parseInt(match[0], 10);
  }

  return null; // do NOT assume 1 automatically
}

export async function refineUserPrompt(
  input: string
): Promise<RefinementResult> {

  const cleaned = normalizeInput(input);

  // 🔥 FAST PATH
  const modality = detectModality(cleaned);
  const count = detectCount(cleaned);
  

  if (modality) {

  const count = detectCount(cleaned);

  if (count === null) {
    return {
      refinedPrompt: cleaned,
      isComplete: false,
      modality,
      message: "How many assets do you need?"
    };
  }

  const missing = detectMissingDetails(cleaned);

  if (missing.length > 0) {
    return {
      refinedPrompt: cleaned,
      isComplete: false,
      modality,
      count,
      message: `To improve results, please clarify: ${missing.join(", ")}.`
    };
  }

  return {
    refinedPrompt: cleaned,
    isComplete: true,
    modality,
    count
  };
}
  // 🔥 LLM FALLBACK (Only if modality not found)

  console.log("LLM fallback refinement used.");

  const checkPrompt = `
Analyze this request:

"${cleaned}"

Return ONLY valid JSON.

If modality (image, video, audio) can be inferred:

{
  "isComplete": true,
  "refinedPrompt": "",
  "modality": "image|video|audio",
  "count": number
}
If unclear:
{
  "isComplete": false,
  "message": "Please specify whether you need an image, video, or audio."
}
`.trim();

  const response = await askPromptEngine(checkPrompt);

  try {
    const parsed = JSON.parse(response);

    console.log("LLM refinement result:", parsed);

    return parsed;
  } catch (e) {
    console.error("Failed to parse LLM JSON. Returning fallback.");

    return {
      refinedPrompt: cleaned,
      isComplete: false,
      message: "Please specify whether you need an image, video, or audio.",
    };
  }
}