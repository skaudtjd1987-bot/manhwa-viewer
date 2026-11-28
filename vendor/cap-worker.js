/* v20 caption worker: Whisper ASR + optional Marian translation. Runs off the UI thread. */
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/+esm";

env.allowLocalModels = false;
env.useBrowserCache = true;
env.allowRemoteModels = true;
try {
  if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
    env.backends.onnx.wasm.numThreads = 1;
  }
} catch (_) {}

const MODELS = {
  asr: "Xenova/whisper-tiny",
  ja: "Xenova/opus-mt-en-jap",
  ko: "noticemkjung/opus-mt-tc-big-en-ko-ONNX",
};

let asr = null, asrDevice = "wasm";
const mt = { ja: null, ko: null };
let cancelled = false;

function prog(phase, pct, detail) {
  self.postMessage({ type: "progress", phase, pct: Math.max(0, Math.min(100, pct || 0)), detail: detail || "" });
}

async function devicePref() {
  try {
    if (self.navigator && self.navigator.gpu && self.navigator.gpu.requestAdapter) {
      const ad = await self.navigator.gpu.requestAdapter();
      if (ad) return "webgpu";
    }
  } catch (_) {}
  try {
    if (env.backends && env.backends.onnx) env.backends.onnx.backend = "wasm";
  } catch (_) {}
  return "wasm";
}

async function loadAsr() {
  if (asr) return asr;
  const want = await devicePref();
  const opts = {
    dtype: "q8",
    progress_callback: (p) => {
      const frac = p && typeof p.progress === "number" ? p.progress : (p && p.status === "ready" ? 100 : 0);
      const name = (p && (p.file || p.name)) || "";
      prog("model", frac, name ? ("모델: " + String(name).split("/").pop()) : "음성 인식 모델을 준비하는 중");
    },
  };
  try {
    if (want === "webgpu") {
      asr = await pipeline("automatic-speech-recognition", MODELS.asr, { ...opts, device: "webgpu" });
      asrDevice = "webgpu";
      return asr;
    }
  } catch (e) {
    asr = null;
  }
  asr = await pipeline("automatic-speech-recognition", MODELS.asr, { ...opts, device: "wasm" });
  asrDevice = "wasm";
  return asr;
}

async function loadMt(pair) {
  if (mt[pair]) return mt[pair];
  const id = MODELS[pair];
  if (!id) throw new Error("지원하지 않는 번역: " + pair);
  const isKo = pair === "ko";
  const opts = {
    // Prefer non-merged q8 for Korean: the repo's decoder_model_merged_quantized.onnx is ~670MB.
    dtype: isKo
      ? { encoder_model: "q8", decoder_model: "q8", decoder_with_past_model: "q8" }
      : "q8",
    progress_callback: (p) => {
      const frac = p && typeof p.progress === "number" ? p.progress : 0;
      const name = (p && (p.file || p.name)) || "";
      const total = p && (p.total || p.size);
      if (isKo && (/merged_quantized|merged_int8/i.test(name) || (total && total > 350 * 1024 * 1024))) {
        throw new Error("한국어 번역 모델이 너무 커서 받지 않았어요");
      }
      if (total && total > 350 * 1024 * 1024) {
        throw new Error("번역 모델이 너무 커서 받지 않았어요");
      }
      prog("mt", frac, name ? ("번역 모델: " + String(name).split("/").pop()) : (pair === "ko" ? "한국어 번역 모델" : "일본어 번역 모델"));
    },
  };
  try {
    const device = asrDevice === "webgpu" && !isKo ? "webgpu" : "wasm";
    mt[pair] = await pipeline("translation", id, { ...opts, device });
    return mt[pair];
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/너무 커서/.test(msg)) throw e;
    if (isKo) throw e;
    mt[pair] = await pipeline("translation", id, { ...opts, device: "wasm" });
    return mt[pair];
  }
}

function chunksToCues(out) {
  const chunks = (out && out.chunks) || [];
  const cues = [];
  if (chunks.length) {
    for (const c of chunks) {
      const ts = c.timestamp || [0, 0];
      const start = Math.max(0, Number(ts[0]) || 0);
      let end = Number(ts[1]);
      if (!isFinite(end) || end <= start) end = start + 2;
      const text = String(c.text || "").replace(/\s+/g, " ").trim();
      if (text) cues.push({ start, end, text });
    }
  } else if (out && out.text && String(out.text).trim()) {
    cues.push({ start: 0, end: 2, text: String(out.text).trim() });
  }
  // merge tiny fragments and clamp overlaps
  const merged = [];
  for (const c of cues) {
    const prev = merged[merged.length - 1];
    if (prev && c.start - prev.end < 0.12 && (prev.text + " " + c.text).length < 80) {
      prev.end = Math.max(prev.end, c.end);
      prev.text = (prev.text + " " + c.text).replace(/\s+/g, " ").trim();
    } else merged.push({ ...c });
  }
  // collapse obvious loops (tiny models sometimes repeat)
  for (const c of merged) {
    c.text = c.text.replace(/\b(.{2,20}?)(?:\s+\1){3,}\b/g, "$1").replace(/\s+/g, " ").trim();
  }
  return merged;
}

async function transcribe(audio, sampleRate, language, task) {
  cancelled = false;
  const pipe = await loadAsr();
  if (cancelled) throw new Error("cancelled");
  prog("asr", 5, "음성을 받아적는 중");
  const opts = {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    task: task === "translate" ? "translate" : "transcribe",
  };
  if (language && language !== "auto") opts.language = language;
  const out = await pipe(audio, opts);
  if (cancelled) throw new Error("cancelled");
  return chunksToCues(out);
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
      const r = await pipe(src, { max_new_tokens: 128 });
      const item = Array.isArray(r) ? r[0] : r;
      text = (item && (item.translation_text || item.text)) || src;
    } catch (_) { text = src; }
    out.push({ start: cues[i].start, end: cues[i].end, text: String(text).trim() || src });
  }
  return out;
}

self.onmessage = async (ev) => {
  const m = ev.data || {};
  try {
    if (m.type === "cancel") { cancelled = true; return; }
    if (m.type === "info") {
      self.postMessage({ type: "info", device: await devicePref(), models: MODELS });
      return;
    }
    if (m.type === "warmup") {
      await loadAsr();
      self.postMessage({ type: "ready", device: asrDevice, model: MODELS.asr });
      return;
    }
    if (m.type === "transcribe") {
      cancelled = false;
      const cues = await transcribe(m.audio, m.sampleRate || 16000, m.language || "auto", m.task || "transcribe");
      self.postMessage({ type: "cues", kind: m.kind || "orig", cues, device: asrDevice });
      return;
    }
    if (m.type === "translate") {
      cancelled = false;
      const cues = await translateCues(m.cues || [], m.pair);
      self.postMessage({ type: "cues", kind: m.kind || m.pair, cues });
      return;
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (msg === "cancelled") self.postMessage({ type: "cancelled" });
    else self.postMessage({ type: "error", message: msg });
  }
};
