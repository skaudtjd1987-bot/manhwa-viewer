/* v21 manga OCR worker: tesseract.js language packs, on-device, never censors. */
import Tesseract from "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/+esm";

const LANG_PATH = "https://tessdata.projectnaptha.com/4.0.0";
let worker = null, workerLangs = "";
let cancelled = false;

function prog(pct, detail) {
  self.postMessage({ type: "progress", phase: "ocr", pct: Math.max(0, Math.min(100, pct || 0)), detail: detail || "" });
}

async function getWorker(langs) {
  const key = (langs || "eng").split("+").filter(Boolean).sort().join("+");
  if (worker && workerLangs === key) return worker;
  if (worker) { try { await worker.terminate(); } catch (_) {} worker = null; }
  prog(2, "문자 인식 엔진을 준비하는 중");
  worker = await Tesseract.createWorker(key, 1, {
    langPath: LANG_PATH,
    workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js",
    corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd.wasm.js",
    logger: (m) => {
      if (!m) return;
      if (m.status === "loading language traineddata") prog(10, "문자 언어 팩을 여는 중");
      else if (m.status === "initializing api") prog(25, "인식 준비");
      else if (m.status === "recognizing text" && typeof m.progress === "number") prog(30 + m.progress * 65, "글자를 읽는 중");
    },
    errorHandler: () => {},
    cacheMethod: "webcache",
    gzip: true,
  });
  workerLangs = key;
  return worker;
}

function clusterWords(words, W, H) {
  const usable = (words || []).filter((w) => {
    const t = String(w.text || "").trim();
    if (!t || t.length === 0) return false;
    const conf = w.confidence == null ? 80 : w.confidence;
    if (conf < 35) return false;
    const b = w.bbox || {};
    const w0 = (b.x1 || 0) - (b.x0 || 0), h0 = (b.y1 || 0) - (b.y0 || 0);
    return w0 > 4 && h0 > 4;
  });
  usable.sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));
  const groups = [];
  const used = new Set();
  for (let i = 0; i < usable.length; i++) {
    if (used.has(i)) continue;
    const g = [usable[i]];
    used.add(i);
    let changed = true;
    while (changed) {
      changed = false;
      const bb = union(g);
      const padX = Math.max(24, (bb.x1 - bb.x0) * 0.25);
      const padY = Math.max(20, (bb.y1 - bb.y0) * 0.45);
      for (let j = 0; j < usable.length; j++) {
        if (used.has(j)) continue;
        const b = usable[j].bbox;
        if (b.x0 < bb.x1 + padX && b.x1 > bb.x0 - padX && b.y0 < bb.y1 + padY && b.y1 > bb.y0 - padY) {
          g.push(usable[j]); used.add(j); changed = true;
        }
      }
    }
    groups.push(g);
  }
  return groups.map((g) => {
    const bb = union(g);
    const texts = g.map((w) => String(w.text || "").trim()).filter(Boolean);
    const tall = (bb.y1 - bb.y0) > (bb.x1 - bb.x0) * 1.35;
    const hasCJK = texts.some((t) => /[\u3040-\u30ff\u3400-\u9fff]/.test(t));
    return {
      x: bb.x0 / W,
      y: bb.y0 / H,
      w: (bb.x1 - bb.x0) / W,
      h: (bb.y1 - bb.y0) / H,
      text: texts.join(tall && hasCJK ? "" : " ").replace(/\s+/g, " ").trim(),
      dir: tall && hasCJK ? "v" : "h",
    };
  }).filter((b) => b.text && b.w > 0.03 && b.h > 0.02);
}

function union(g) {
  let x0 = 1e9, y0 = 1e9, x1 = 0, y1 = 0;
  for (const w of g) {
    const b = w.bbox;
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0);
    x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  const pad = 8;
  return { x0: Math.max(0, x0 - pad), y0: Math.max(0, y0 - pad), x1: x1 + pad, y1: y1 + pad };
}

async function recognize(image, langs) {
  cancelled = false;
  const w = await getWorker(langs || "eng+jpn");
  if (cancelled) throw new Error("cancelled");
  const res = await w.recognize(image, { rotateAuto: true });
  const data = res && res.data || {};
  const W = data.imageWidth || (image && image.width) || 1;
  const H = data.imageHeight || (image && image.height) || 1;
  const words = (data.words || []).map((wd) => ({
    text: wd.text,
    confidence: wd.confidence,
    bbox: wd.bbox,
  }));
  let bubbles = clusterWords(words, W, H);
  if (!bubbles.length && data.text && String(data.text).trim()) {
    bubbles = [{ x: 0.15, y: 0.15, w: 0.7, h: 0.2, text: String(data.text).trim(), dir: "h" }];
  }
  return bubbles;
}

self.onmessage = async (ev) => {
  const m = ev.data || {};
  try {
    if (m.type === "cancel") { cancelled = true; return; }
    if (m.type === "warmup") {
      await getWorker(m.langs || "eng");
      self.postMessage({ type: "ready", langs: workerLangs });
      return;
    }
    if (m.type === "ocr") {
      cancelled = false;
      const bubbles = await recognize(m.image, m.langs || "eng+jpn");
      self.postMessage({ type: "bubbles", bubbles });
      return;
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (msg === "cancelled") self.postMessage({ type: "cancelled" });
    else self.postMessage({ type: "error", message: msg });
  }
};
