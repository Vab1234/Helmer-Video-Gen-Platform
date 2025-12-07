// src/types/semanticMap.ts

export interface IntentExtraction {
  modality?: string;          // "image" | "video" | "audio"
  domain?: string;
  primary_subject?: string;
  context_scene?: string;
  style_adjectives?: string[];
}

export interface RealismScoring {
  realism_score?: number;         // 0.0–1.0
  abstractness_score?: number;    // 0.0–1.0
  rationale?: string;

  // optional extra scores (you referenced them in Python)
  subject_context_score?: number;
  modifier_abstractness_score?: number;
  domain_feasibility_score?: number;
}

export type FeasibilityLabel = "feasible" | "partially_feasible" | "fantasy";

export interface FeasibilityJudgement {
  feasibility_label?: FeasibilityLabel | string;
  realism_overall_score?: number;      // 0.0–1.0
  creative_potential_score?: number;   // 0.0–1.0
  summary?: string;
}

export interface CostLatency {
  cost?: string;    // "low" | "medium" | "high" or similar
  latency?: string;
}

export interface CostLatencyEstimate {
  fetch?: CostLatency;
  generate?: CostLatency;
}

export interface DecisionReasoning {
  reasoning_trace?: string;
  cost_latency_estimate?: CostLatencyEstimate;
  final_decision?: string;  // "fetch_from_web" | "generate_with_model" | ...
  confidence?: number;      // 0.0–1.0
}

export type MediaType = "image" | "video" | "audio";

export interface FetchedAsset {
  type: MediaType;
  filename: string;
  source?: string;
  media_url?: string;
  page_url?: string;
  alt?: string | null;
  query_used?: string | null;
  width?: number;
  height?: number;
  sha256?: string;
}

export interface SemanticMap {
  user_prompt: string;

  intent_extraction?: IntentExtraction;
  realism_scoring?: RealismScoring;
  feasibility_judgement?: FeasibilityJudgement;
  decision_reasoning?: DecisionReasoning;

  fetched_assets?: FetchedAsset[];
  relevant_assets?: FetchedAsset[];

  // allow additional keys if needed
  [key: string]: any;
}
