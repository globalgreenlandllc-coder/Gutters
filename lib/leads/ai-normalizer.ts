import OpenAI from "openai";

export type CategorizedTrade = "Roofing" | "Gutters" | "Framing" | "Siding" | "Windows" | "General" | "Other";

export async function normalizePermitDescription(description: string): Promise<CategorizedTrade> {
  if (!process.env.OPENAI_API_KEY) {
    // Fallback simple regex parsing if no API key
    const lowerDesc = description.toLowerCase();
    if (lowerDesc.includes("roof") || lowerDesc.includes("r&r") && lowerDesc.includes("shingle")) return "Roofing";
    if (lowerDesc.includes("gutter") || lowerDesc.includes("downspout")) return "Gutters";
    if (lowerDesc.includes("framing") || lowerDesc.includes("addition")) return "Framing";
    if (lowerDesc.includes("siding")) return "Siding";
    if (lowerDesc.includes("window")) return "Windows";
    return "Other";
  }

  try {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an expert construction permit analyzer.
You will be given a raw municipal permit description.
Your job is to categorize the primary trade involved into EXACTLY ONE of the following options:
"Roofing", "Gutters", "Framing", "Siding", "Windows", "General", or "Other".
Return ONLY the categorized word, nothing else.`,
        },
        {
          role: "user",
          content: description,
        },
      ],
      temperature: 0,
      max_tokens: 10,
    });

    const trade = response.choices[0].message.content?.trim() as CategorizedTrade;
    const validTrades: CategorizedTrade[] = ["Roofing", "Gutters", "Framing", "Siding", "Windows", "General", "Other"];
    
    if (validTrades.includes(trade)) {
      return trade;
    }
    return "Other";
  } catch (error) {
    console.error("AI Normalizer Error:", error);
    return "Other";
  }
}
