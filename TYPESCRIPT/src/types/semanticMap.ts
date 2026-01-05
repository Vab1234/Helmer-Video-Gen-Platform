// src/types/semanticMap.ts

export interface IntentExtraction {
  modality?: string;
  domain?: string;
  primary_subject?: string;
  context_scene?: string;
  style_adjectives?: string[];
}

export interface RealismScoring {
  realism_score?: number;
  abstractness_score?: number;
  rationale?: string;
  subject_context_score?: number;
  modifier_abstractness_score?: number;
  domain_feasibility_score?: number;
}

export type FeasibilityLabel = "feasible" | "partially_feasible" | "fantasy";

export interface FeasibilityJudgement {
  feasibility_label?: FeasibilityLabel | string;
  realism_overall_score?: number;
  creative_potential_score?: number;
  summary?: string;
}

export interface CostLatency {
  cost?: string;
  latency?: string;
}

export interface CostLatencyEstimate {
  fetch?: CostLatency;
  generate?: CostLatency;
}

export interface DecisionReasoning {
  reasoning_trace?: string;
  cost_latency_estimate?: CostLatencyEstimate;
  final_decision?: string;
  confidence?: number;
}

export type MediaType = "image" | "video" | "audio";

// --- NEW CLASSIFICATION TYPES ---
export interface TechnicalStats {
  width?: number;
  height?: number;
  orientation: "landscape" | "portrait" | "square";
  duration?: number; // seconds
  file_size_mb?: string;
}

export interface SemanticTags {
  shot_type: string;       // e.g. "Wide", "Close-up", "Drone"
  lighting: string;        // e.g. "Golden Hour", "Studio", "Natural"
  mood: string;            // e.g. "Happy", "Melancholic", "Cinematic"
  subject: string;         // e.g. "Cat sleeping"
  aesthetic_score: number; // 1-10
  keywords: string[];      // ["cat", "fur", "sleep", "bed"]
}

export interface AssetClassification {
  technical: TechnicalStats;
  semantic: SemanticTags;
}
// --------------------------------

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
  
  // New fields
  score?: number; // Relevance score from previous step
  classification?: AssetClassification; // <--- The new rich data
}

export interface SemanticMap {
  user_prompt: string;
  intent_extraction?: IntentExtraction;
  realism_scoring?: RealismScoring;
  feasibility_judgement?: FeasibilityJudgement;
  decision_reasoning?: DecisionReasoning;
  fetched_assets?: FetchedAsset[];
  relevant_assets?: FetchedAsset[];
  [key: string]: any;
}