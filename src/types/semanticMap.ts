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
  cost?: string;    // "low" | "medium" | "high"
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
  confidence?: number;
}

export type MediaType = "image" | "video" | "audio";

// --- NEW: Technical Metadata Interface ---
export interface AssetTechnicalData {
  width: number;
  height: number;
  orientation: string;
  aspect_ratio: string;
  duration: number;
  fps?: number;
  codec?: string;
  file_size_mb: number;
}

// --- UPDATED: AssetClassification ---
export interface AssetSemanticClassification {
  labels: string[];
  confidence: number;
  human_presence: boolean;
  environment?: string;
}
// src/types/semanticMap.ts

export interface AssetSemantics {
  primary_scene?: string;
  environment?: string;
  time_of_day?: string;
  weather?: string;
  indoor_outdoor?: string;

  shot_type?: string;
  camera_angle?: string;
  composition?: string;
  lighting?: string;

  mood?: string;
  atmosphere?: string;

  human_presence?: boolean;
  people_count_estimate?: number;
  primary_activity?: string;

  dominant_objects?: string[];
  tags?: string[];

  confidence?: number;

  palette?: string[];
}

export interface AssetClassification {
  technical: {
    type: "image" | "video"; // Add this so your table can use it
    width: number;
    height: number;
    orientation: string;
    aspect_ratio: string;
    duration: number;
    fps?: number;
    codec?: string;
    file_size_mb: number;
  };
  
  // Change 'semantic' to 'semantics' to match your pipeline code
  semantics?: AssetSemantics; 

  origin: "generated" | "scraped";
  aspect_ratio: string;

}
export interface FetchedAsset {
  type: MediaType;
  filename: string;
  source?: string;
  media_url?: string;
  page_url?: string;
  alt?: string | null;
  query_used?: string | null;
  classification?: AssetClassification;
  width?: number;
  height?: number;
  sha256?: string;
}

export interface SemanticMap {
  user_prompt: string;

  requested_asset_count?: number;  // ✅ ADD THIS
  requested_modality?: MediaType;  // ✅ OPTIONAL BUT CLEAN

  intent_extraction?: IntentExtraction;
  realism_scoring?: RealismScoring;
  feasibility_judgement?: FeasibilityJudgement;
  market_availability_estimate?: number;
  decision_reasoning?: DecisionReasoning;
  fetched_assets?: FetchedAsset[];
  relevant_assets?: FetchedAsset[];
  [key: string]: any;
}