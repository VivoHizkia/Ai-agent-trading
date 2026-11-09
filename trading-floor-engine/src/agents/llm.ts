// Satu pintu untuk semua panggilan AI (debat, sentimen, laporan Head Trader).
// Provider dipilih lewat .env:
//   LLM_PROVIDER=gemini      + GEMINI_API_KEY      (Google AI Studio, ada free tier, tanpa kartu)
//   LLM_PROVIDER=openrouter  + OPENROUTER_API_KEY  (bisa bayar USDC; model gratis lewat "openrouter/free")
//   LLM_PROVIDER=anthropic   + ANTHROPIC_API_KEY   (perilaku lama)
// Kalau LLM_PROVIDER kosong: Gemini kalau GEMINI_API_KEY ada, lalu OpenRouter, lalu Anthropic.
// AI hanya dipakai untuk narasi/penilaian; keputusan entry tetap dari strategi + Risk Engine.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export type Provider = "gemini" | "openrouter" | "anthropic";

export function llmProvider(): Provider {
  const p = (process.env.LLM_PROVIDER ?? "").toLowerCase();
  if (p === "gemini" || p === "openrouter" || p === "anthropic") return p;
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  return "anthropic";
}

interface Req { system: string; user: string; maxTokens: number; anthropicModel: string }

/* ------------------------------------------------------------------ Gemini (REST, tanpa SDK) */

const GEMINI_BASE = (process.env.GEMINI_API_BASE ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
let geminiModelCache: string | null = null;

/** GEMINI_MODEL kalau diisi; kalau tidak, pilih otomatis model Flash teks yang tersedia untuk key ini (free tier). */
async function geminiModel(): Promise<string> {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL.replace(/^models\//, "");
  if (geminiModelCache) return geminiModelCache;
  const res = await fetch(`${GEMINI_BASE}/models?pageSize=200`, { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY! }, signal: AbortSignal.timeout(20_000) });
  const j = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[]; error?: { message: string } };
  if (!res.ok) throw new Error(`Gemini: ${j.error?.message ?? res.status}`);
  const usable = (j.models ?? [])
    .filter(m => m.supportedGenerationMethods?.includes("generateContent"))
    .map(m => m.name.replace(/^models\//, ""))
    .filter(n => /gemini/i.test(n) && !/(tts|live|image|embed|transcri|audio|vision|exp|preview)/i.test(n));
  const pick = usable.find(n => /flash-lite/.test(n)) ?? usable.find(n => /flash/.test(n)) ?? usable[0];
  if (!pick) throw new Error("Gemini: tidak ada model teks yang tersedia untuk API key ini. Isi GEMINI_MODEL di .env.");
  geminiModelCache = pick;
  return pick;
}

async function gemini(req: Req, json: boolean): Promise<{ text: string; model: string }> {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY belum diisi di .env");
  const model = await geminiModel();
  const body = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: "user", parts: [{ text: req.user }] }],
    generationConfig: { maxOutputTokens: Math.max(req.maxTokens, 1024), temperature: 0.4, ...(json ? { responseMimeType: "application/json" } : {}) },
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    });
    const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message: string; code?: number } };
    if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 4000 * (attempt + 1))); continue; } // limit free tier: tunggu sebentar
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${j.error?.message ?? "?"}`);
    const text = (j.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? "").join("").trim();
    if (!text) throw new Error("Gemini: jawaban kosong (mungkin diblokir filter keamanan)");
    return { text, model: `gemini/${model}` };
  }
  throw new Error("Gemini: batas free tier tercapai (429). Coba lagi nanti.");
}

/* ------------------------------------------------------------------ OpenRouter (OpenAI-compatible) */

async function openrouter(req: Req, json: boolean): Promise<{ text: string; model: string }> {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY belum diisi di .env");
  const model = process.env.OPENROUTER_MODEL ?? "openrouter/free";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${(process.env.OPENROUTER_API_BASE ?? "https://openrouter.ai/api/v1").replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "X-Title": "Trading Floor" },
      body: JSON.stringify({
        model, max_tokens: Math.max(req.maxTokens, 1024), temperature: 0.4,
        messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
        ...(json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; model?: string; error?: { message: string } };
    if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 5000 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${j.error?.message ?? "?"}`);
    const text = j.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) throw new Error("OpenRouter: jawaban kosong");
    return { text, model: `openrouter/${j.model ?? model}` };
  }
  throw new Error("OpenRouter: batas request tercapai (429). Model gratis dibatasi per hari.");
}

/* ------------------------------------------------------------------ API publik */

/** Jawaban teks bebas. */
export async function llmText(req: Req): Promise<{ text: string; model: string }> {
  const p = llmProvider();
  if (p === "gemini") return gemini(req, false);
  if (p === "openrouter") return openrouter(req, false);
  const client = new Anthropic();
  const r = await client.messages.create({ model: req.anthropicModel, max_tokens: req.maxTokens, system: req.system, messages: [{ role: "user", content: req.user }] });
  const t = r.content.find(b => b.type === "text");
  return { text: t && t.type === "text" ? t.text : "", model: req.anthropicModel };
}

function extractJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(cleaned); } catch { /* cari blok {...} pertama */ }
  const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(cleaned.slice(a, b + 1));
  throw new Error("jawaban bukan JSON");
}

/** Jawaban terstruktur yang divalidasi zod. Gemini/OpenRouter: skema dikirim di prompt, hasil diparse + dicoba ulang sekali. */
export async function llmJson<T extends z.ZodType>(schema: T, req: Req): Promise<{ data: z.infer<T>; model: string }> {
  const p = llmProvider();
  if (p === "anthropic") {
    const client = new Anthropic();
    const r = await client.messages.parse({
      model: req.anthropicModel, max_tokens: req.maxTokens, system: req.system,
      messages: [{ role: "user", content: req.user }],
      output_config: { format: zodOutputFormat(schema) },
    });
    if (!r.parsed_output) throw new Error("Gagal parse jawaban Claude");
    return { data: r.parsed_output as z.infer<T>, model: req.anthropicModel };
  }
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
  const user = `${req.user}\n\nBalas HANYA dengan satu objek JSON valid (tanpa teks lain, tanpa markdown) yang sesuai JSON Schema ini:\n${jsonSchema}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = p === "gemini" ? await gemini({ ...req, user }, true) : await openrouter({ ...req, user }, true);
    try {
      const parsed = schema.safeParse(extractJson(r.text));
      if (parsed.success) return { data: parsed.data, model: r.model };
      lastErr = parsed.error.issues[0]?.message;
    } catch (e) { lastErr = (e as Error).message; }
  }
  throw new Error(`Jawaban AI tidak sesuai format: ${String(lastErr)}`);
}
