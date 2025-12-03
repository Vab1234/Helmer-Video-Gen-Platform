// src/pipeline/modalityRouting.ts
import { SemanticMap, MediaType } from "../types/semanticMap";

export function getModality(semanticMap: SemanticMap): MediaType | "" {
  const intent = semanticMap.intent_extraction ?? {};
  const modalityRaw = (intent.modality ?? "").toString().trim().toLowerCase();

  if (modalityRaw === "image" || modalityRaw === "video" || modalityRaw === "audio") {
    return modalityRaw as MediaType;
  }
  return "";
}

export function detectModality(semanticMap: SemanticMap): MediaType {
  const m = getModality(semanticMap);
  if (m) return m;
  // fallback to image if unknown
  return "image";
}
