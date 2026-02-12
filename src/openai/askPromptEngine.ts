// src/openai/askPromptEngine.ts
import { openaiClient } from "./client";

export async function askPromptEngine(
  prompt: string,
  model = "gpt-4o-mini"
): Promise<string> {
  const completion = await openaiClient.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content: "You are a reasoning engine that analyzes creative prompts.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0.4,
    max_tokens: 700,
  });

  return completion.choices[0]?.message?.content ?? "";
}
