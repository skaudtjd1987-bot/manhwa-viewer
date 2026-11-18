/* Classic worker: official @ffmpeg/core UMD + transferred wasmBinary */
let core = null;

function postErr(id, msg) {
  self.postMessage({ id, type: "error", error: String(msg || "ffmpeg 오류") });
}

async function loadCore(wasmBinary) {
  if (core) return;
  if (typeof createFFmpegCore !== "function") {
    throw new Error("ffmpeg-core.js가 로드되지 않았습니다.");
  }
  const wasm = wasmBinary instanceof Uint8Array ? wasmBinary : new Uint8Array(wasmBinary);
  core = await createFFmpegCore({
    wasmBinary: wasm,
    locateFile: (path) => path,
    print: () => {},
    printErr: () => {},
  });
}

function writeIn(name, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  try { core.FS.unlink(name); } catch (_) {}
  core.FS.writeFile(name, bytes);
}

function readOut(name) {
  const out = core.FS.readFile(name);
  try { core.FS.unlink(name); } catch (_) {}
  return out;
}

function execChain(list) {
  let lastErr = null;
  for (const args of list) {
    try {
      core.reset && core.reset();
      const ret = core.exec(...args);
      if (ret === 0 || ret === undefined || ret === -1) {
        // -1 can still have produced output in some builds; check file
      }
      try {
        const st = core.FS.stat("out.dat") || core.FS.stat("out.jpg") || null;
      } catch (_) {}
      return { ok: true, args };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("변환에 실패했습니다.");
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  const { id, cmd } = msg;
  try {
    if (cmd === "initCoreScript") {
      // importScripts must be same-origin or blob
      importScripts(msg.coreUrl);
      self.postMessage({ id, type: "ok" });
      return;
    }
    if (cmd === "load") {
      await loadCore(msg.wasm);
      self.postMessage({ id, type: "ok" });
      return;
    }
    if (!core) throw new Error("코덱 엔진이 아직 준비되지 않았습니다.");
    if (cmd === "encoders") {
      // not all builds support help reliably
      self.postMessage({ id, type: "ok", data: "ready" });
      return;
    }
    if (cmd === "toJpeg") {
      const input = msg.name || "in.bin";
      writeIn(input, msg.data);
      try { core.FS.unlink("out.jpg"); } catch (_) {}
      const tries = [
        ["-hide_banner", "-nolog", "-i", input, "-frames:v", "1", "-q:v", "3", "out.jpg"],
        ["-i", input, "-frames:v", "1", "-q:v", "3", "out.jpg"],
        ["-i", input, "-frames:v", "1", "out.jpg"],
      ];
      let done = false, lastErr;
      for (const args of tries) {
        try {
          core.reset && core.reset();
          core.exec(...args);
          const out = core.FS.readFile("out.jpg");
          if (out && out.length) {
            try { core.FS.unlink(input); } catch (_) {}
            try { core.FS.unlink("out.jpg"); } catch (_) {}
            self.postMessage({ id, type: "ok", data: out }, [out.buffer]);
            done = true;
            break;
          }
        } catch (e) { lastErr = e; }
      }
      try { core.FS.unlink(input); } catch (_) {}
      if (!done) throw lastErr || new Error("이미지를 변환할 수 없습니다.");
      return;
    }
    if (cmd === "toMp4") {
      const input = msg.name || "in.bin";
      writeIn(input, msg.data);
      try { core.FS.unlink("out.mp4"); } catch (_) {}
      const tries = [
        ["-i", input, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-crf", "23", "-c:a", "aac", "-movflags", "+faststart", "out.mp4"],
        ["-i", input, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-an", "-movflags", "+faststart", "out.mp4"],
        ["-i", input, "-c:v", "mpeg4", "-q:v", "5", "-c:a", "aac", "out.mp4"],
        ["-i", input, "-c:v", "mpeg4", "-q:v", "5", "-an", "out.mp4"],
        ["-i", input, "-c", "copy", "-movflags", "+faststart", "out.mp4"],
      ];
      let done = false, lastErr;
      for (const args of tries) {
        try {
          core.reset && core.reset();
          core.exec(...args);
          const out = core.FS.readFile("out.mp4");
          if (out && out.length > 32) {
            try { core.FS.unlink(input); } catch (_) {}
            try { core.FS.unlink("out.mp4"); } catch (_) {}
            self.postMessage({ id, type: "ok", data: out }, [out.buffer]);
            done = true;
            break;
          }
        } catch (e) { lastErr = e; }
      }
      try { core.FS.unlink(input); } catch (_) {}
      if (!done) throw lastErr || new Error("영상을 변환할 수 없습니다.");
      return;
    }
    throw new Error("알 수 없는 명령입니다.");
  } catch (e) {
    postErr(id, e && e.message ? e.message : e);
  }
};
