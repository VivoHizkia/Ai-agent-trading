// Cek cepat koneksi AI: npm run llm:test
import "dotenv/config";
import { llmProvider, llmText } from "./llm.js";

const p = llmProvider();
console.log(`Provider: ${p}`);
try {
  const r = await llmText({ system: "Jawab singkat dalam Bahasa Indonesia.", user: "Sebutkan satu kalimat bahwa koneksi AI berhasil.", maxTokens: 100, anthropicModel: "claude-haiku-4-5" });
  console.log(`Model: ${r.model}\nJawaban: ${r.text}\nBERHASIL ✅`);
} catch (e) {
  console.log(`GAGAL ❌ ${(e as Error).message}`);
  process.exitCode = 1;
}
