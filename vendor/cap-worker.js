/* v21 caption worker: Whisper ASR (tiered) + Marian translation. On-device only. Never censors. */
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/+esm";

env.allowLocalModels = false;
env.useBrowserCache = true;
env.allowRemoteModels = true;
try {
  if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
    env.backends.onnx.wasm.numThreads = 1;
  }
} catch (_) {}

export const ASR = {
  fast: { id: "Xenova/whisper-tiny", dtype: "q8", label: "빠름" },
  balanced: { id: "Xenova/whisper-base", dtype: "q8", label: "균형" },
  accurate: { id: "Xenova/whisper-small", dtype: "q8", label: "정확" },
  max: { id: "onnx-community/whisper-large-v3-turbo", dtype: "q4", label: "최고 정확" },
};

export const MT = {
  "en-ja": "Xenova/opus-mt-en-jap",
  "ja-en": "Xenova/opus-mt-jap-en",
  "en-zh": "Xenova/opus-mt-en-zh",
  "zh-en": "Xenova/opus-mt-zh-en",
  "en-es": "Xenova/opus-mt-en-es",
  "es-en": "Xenova/opus-mt-es-en",
  "ko-en": "Xenova/opus-mt-ko-en",
  "en-ko": "teamwon/opus-mt-en-ko-onnx",
};

const KO_HEAVY = new Set(["en-ko"]);

let asr = null, asrKey = "", asrDevice = "wasm";
const mt = {};
let cancelled = false;

function prog(phase, pct, detail, extra) {
  self.postMessage(Object.assign({ type: "progress", phase, pct: Math.max(0, Math.min(100, pct || 0)), detail: detail || "" }, extra || {}));
}

async function devicePref() {
  try {
    if (self.navigator && self.navigator.gpu && self.navigator.gpu.requestAdapter) {
      const ad = await self.navigator.gpu.requestAdapter();
      if (ad) return "webgpu";
    }
  } catch (_) {}
  try { if (env.backends && env.backends.onnx) env.backends.onnx.backend = "wasm"; } catch (_) {}
  return "wasm";
}

function buildPrompt(language, vocab) {
  const v = String(vocab || "").replace(/\s+/g, " ").trim();
  const names = v ? (" 자주 나오는 단어와 이름: " + v.slice(0, 280)) : "";
  const lang = language || "auto";
  if (lang === "ko" || lang === "auto") {
    // Short on purpose: Whisper's initial_prompt window is small. Never asks to sanitize.
    return ("일상 입말. 경상도·전라도·충청도 사투리, 유행어, 비속어도 들린 그대로 받아 적는다. 순화하지 않는다. "
      + "와이라노 억수로 겁나 징하다 거시기 뭐하노 존나 씨발 개같다 야 그니까 맞다 진짜."
      + names);
  }
  if (lang === "ja") return ("自然な話し言葉。方言・スラング・罵倒も聞こえたまま書き起こす。検閲しない。" + names);
  if (lang === "en") return ("Casual speech. Keep slang, dialect, and profanity verbatim. Do not censor or soften." + names);
  return names.trim();
}

function asrGenerateOpts(language, vocab) {
  const prompt = buildPrompt(language, vocab);
  return {
    return_timestamps: true,
    chunk_length_s: 20,
    stride_length_s: 4,
    temperature: [0, 0.2, 0.4],
    no_repeat_ngram_size: 3,
    repetition_penalty: 1.12,
    compression_ratio_threshold: 2.4,
    logprob_threshold: -1,
    no_speech_threshold: 0.6,
    condition_on_previous_text: true,
    // Do not pass suppress_tokens — keep swear words and slang.
    prompt,
    initial_prompt: prompt,
  };
}

async function loadAsr(tier, offline) {
  const t = ASR[tier] || ASR.accurate;
  const key = t.id + ":" + t.dtype;
  if (asr && asrKey === key) return asr;
  asr = null; asrKey = "";
  if (offline) env.allowRemoteModels = false;
  else env.allowRemoteModels = true;
  const want = await devicePref();
  const opts = {
    dtype: t.dtype,
    progress_callback: (p) => {
      const frac = p && typeof p.progress === "number" ? p.progress : (p && p.status === "ready" ? 100 : 0);
      const name = (p && (p.file || p.name)) || "";
      prog("model", frac, name ? ("모델: " + String(name).split("/").pop()) : (t.label + " 음성 모델을 준비하는 중"));
    },
  };
  try {
    if (want === "webgpu") {
      asr = await pipeline("automatic-speech-recognition", t.id, { ...opts, device: "webgpu" });
      asrDevice = "webgpu";
      asrKey = key;
      return asr;
    }
  } catch (e) {
    asr = null;
  }
  asr = await pipeline("automatic-speech-recognition", t.id, { ...opts, device: "wasm" });
  asrDevice = "wasm";
  asrKey = key;
  return asr;
}


function resolvePair(pair) {
  const p = String(pair || "").trim();
  if (MT[p]) return p;
  // v20 and short target codes: English source unless already a pair
  const alias = { ja: "en-ja", ko: "en-ko", zh: "en-zh", es: "en-es", jap: "en-ja", jp: "en-ja", en: "ja-en" };
  return alias[p] || p;
}
async function loadMt(pair, offline) {
  pair = resolvePair(pair);
  if (mt[pair]) return mt[pair];
  const id = MT[pair];
  if (!id) throw new Error("지원하지 않는 번역: " + pair);
  if (offline) env.allowRemoteModels = false;
  else env.allowRemoteModels = true;
  const heavy = KO_HEAVY.has(pair);
  const opts = {
    dtype: "q8",
    progress_callback: (p) => {
      const frac = p && typeof p.progress === "number" ? p.progress : 0;
      const name = (p && (p.file || p.name)) || "";
      const total = p && (p.total || p.size);
      if (total && total > 400 * 1024 * 1024) throw new Error("번역 모델이 너무 커서 받지 않았어요");
      prog("mt", frac, name ? ("번역 모델: " + String(name).split("/").pop()) : (pair + " 번역 모델"));
    },
  };
  try {
    const device = asrDevice === "webgpu" && !heavy ? "webgpu" : "wasm";
    mt[pair] = await pipeline("translation", id, { ...opts, device });
    return mt[pair];
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/너무 커서/.test(msg) || heavy) throw e;
    mt[pair] = await pipeline("translation", id, { ...opts, device: "wasm" });
    return mt[pair];
  }
}

function chunksToCues(out, offset) {
  offset = offset || 0;
  const chunks = (out && out.chunks) || [];
  const cues = [];
  if (chunks.length) {
    for (const c of chunks) {
      const ts = c.timestamp || [0, 0];
      const start = Math.max(0, (Number(ts[0]) || 0) + offset);
      let end = Number(ts[1]);
      if (!isFinite(end)) end = (Number(ts[0]) || 0) + 2;
      end = end + offset;
      if (end <= start) end = start + 2;
      // Never sanitize text.
      const text = String(c.text || "").replace(/\s+/g, " ").trim();
      if (text) cues.push({ start, end, text });
    }
  } else if (out && out.text && String(out.text).trim()) {
    cues.push({ start: offset, end: offset + 2, text: String(out.text).trim() });
  }
  const merged = [];
  for (const c of cues) {
    const prev = merged[merged.length - 1];
    if (prev && c.start - prev.end < 0.12 && (prev.text + " " + c.text).length < 90) {
      prev.end = Math.max(prev.end, c.end);
      prev.text = (prev.text + " " + c.text).replace(/\s+/g, " ").trim();
    } else merged.push({ ...c });
  }
  for (const c of merged) {
    c.text = c.text.replace(/\b(.{2,20}?)(?:\s+\1){3,}\b/g, "$1").replace(/\s+/g, " ").trim();
  }
  return merged;
}

function slicePcm(audio, sampleRate, start, dur) {
  const a0 = Math.max(0, Math.floor(start * sampleRate));
  const a1 = Math.min(audio.length, Math.floor((start + dur) * sampleRate));
  if (a1 <= a0) return null;
  return audio.subarray(a0, a1);
}

async function transcribeFull(audio, sampleRate, language, task, tier, vocab) {
  cancelled = false;
  const pipe = await loadAsr(tier);
  if (cancelled) throw new Error("cancelled");
  prog("asr", 5, "음성을 받아적는 중");
  const opts = asrGenerateOpts(language, vocab);
  opts.task = task === "translate" ? "translate" : "transcribe";
  if (language && language !== "auto") opts.language = language;
  const out = await pipe(audio, opts);
  if (cancelled) throw new Error("cancelled");
  return chunksToCues(out, 0);
}

async function transcribeProgressive(audio, sampleRate, language, task, tier, vocab, kind) {
  cancelled = false;
  await loadAsr(tier);
  if (cancelled) throw new Error("cancelled");
  const dur = audio.length / (sampleRate || 16000);
  const win = 20, hop = 16;
  const all = [];
  let i = 0, t = 0;
  const n = Math.max(1, Math.ceil(Math.max(0, dur - 0.2) / hop));
  while (t < dur - 0.15) {
    if (cancelled) throw new Error("cancelled");
    const sl = slicePcm(audio, sampleRate, t, Math.min(win, dur - t + 0.05));
    if (!sl || sl.length < sampleRate * 0.2) break;
    prog("asr", Math.round(((i + 1) / n) * 100), `${(t).toFixed(0)}초부터 받아적는 중`, { chunk: i, of: n });
    const opts = asrGenerateOpts(language, vocab);
    opts.task = task === "translate" ? "translate" : "transcribe";
    if (language && language !== "auto") opts.language = language;
    const out = await asr(sl, opts);
    const cues = chunksToCues(out, t);
    for (const c of cues) all.push(c);
    self.postMessage({ type: "chunk", kind: kind || "orig", cues, t, dur, done: false });
    i++; t += hop;
  }
  // merge overlaps
  all.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const c of all) {
    const prev = merged[merged.length - 1];
    if (prev && c.start < prev.end - 0.3 && similar(prev.text, c.text)) {
      prev.end = Math.max(prev.end, c.end);
    } else if (prev && c.start < prev.end && c.start >= prev.start) {
      if (c.end > prev.end) prev.end = c.end;
      if (c.text.length > prev.text.length + 8) prev.text = c.text;
    } else merged.push({ ...c });
  }
  return merged;
}

function similar(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || !b) return false;
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

async function translateCues(cues, pair) {
  cancelled = false;
  const pipe = await loadMt(pair);
  const out = [];
  const n = cues.length || 1;
  for (let i = 0; i < cues.length; i++) {
    if (cancelled) throw new Error("cancelled");
    prog("mt", Math.round(((i + 1) / n) * 100), `${i + 1}/${cues.length} 줄 번역`);
    const src = cues[i].text;
    let text = src;
    try {
      const r = await pipe(src, { max_new_tokens: 160 });
      const item = Array.isArray(r) ? r[0] : r;
      text = (item && (item.translation_text || item.text)) || src;
    } catch (_) { text = src; }
    out.push({ start: cues[i].start, end: cues[i].end, text: String(text).trim() || src });
  }
  return out;
}

async function translateTexts(texts, pair) {
  const pipe = await loadMt(pair);
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    if (cancelled) throw new Error("cancelled");
    const src = String(texts[i] || "");
    let text = src;
    try {
      const r = await pipe(src, { max_new_tokens: 160 });
      const item = Array.isArray(r) ? r[0] : r;
      text = (item && (item.translation_text || item.text)) || src;
    } catch (_) { text = src; }
    out.push(String(text).trim() || src);
  }
  return out;
}

self.onmessage = async (ev) => {
  const m = ev.data || {};
  try {
    if (m.type === "cancel") { cancelled = true; return; }
    if (m.type === "info") {
      self.postMessage({ type: "info", device: await devicePref(), asr: ASR, mt: MT });
      return;
    }
    if (m.type === "warmup") {
      await loadAsr(m.tier || "accurate", !!m.offline);
      self.postMessage({ type: "ready", device: asrDevice, model: (ASR[m.tier || "accurate"] || ASR.accurate).id });
      return;
    }
    if (m.type === "verify") {
      const prev = env.allowRemoteModels;
      try {
        if (m.kind === "asr") await loadAsr(m.tier || "fast", true);
        else if (m.kind === "mt") await loadMt(m.pair, true);
        self.postMessage({ type: "verified", ok: true, id: m.id || m.tier || m.pair });
      } catch (e) {
        self.postMessage({ type: "verified", ok: false, id: m.id || m.tier || m.pair, message: (e && e.message) || String(e) });
      } finally {
        env.allowRemoteModels = prev;
      }
      return;
    }
    if (m.type === "transcribe") {
      cancelled = false;
      const off = Number(m.offset) || 0;
      let cues;
      if (m.progressive) {
        cues = await transcribeProgressive(m.audio, m.sampleRate || 16000, m.language || "auto", m.task || "transcribe", m.tier || "accurate", m.vocab || "", m.kind || "orig");
        if (off) cues = cues.map((c) => ({ start: c.start + off, end: c.end + off, text: c.text }));
      } else {
        cues = await transcribeFull(m.audio, m.sampleRate || 16000, m.language || "auto", m.task || "transcribe", m.tier || "accurate", m.vocab || "");
        if (off) cues = cues.map((c) => ({ start: c.start + off, end: c.end + off, text: c.text }));
      }
      self.postMessage({ type: "cues", kind: m.kind || "orig", cues, device: asrDevice, model: (ASR[m.tier || "accurate"] || ASR.accurate).id, offset: off });
      return;
    }
    if (m.type === "translate") {
      cancelled = false;
      const cues = await translateCues(m.cues || [], resolvePair(m.pair || m.kind));
      self.postMessage({ type: "cues", kind: m.kind || m.pair, cues });
      return;
    }
    if (m.type === "translateTexts") {
      cancelled = false;
      const texts = await translateTexts(m.texts || [], resolvePair(m.pair || m.kind));
      self.postMessage({ type: "texts", kind: m.kind || m.pair, texts });
      return;
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (msg === "cancelled") self.postMessage({ type: "cancelled" });
    else self.postMessage({ type: "error", message: msg });
  }
};
