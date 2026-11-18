/* Classic worker around libarchive.wasm */
let Module = null;
const handles = new Map();
let hid = 1;

async function ensureModule(wasmBinary) {
  if (Module) return Module;
  if (typeof libarchiveFactory !== "function") {
    throw new Error("libarchive 엔진이 로드되지 않았습니다.");
  }
  const wasm = wasmBinary instanceof Uint8Array ? wasmBinary : new Uint8Array(wasmBinary);
  Module = await libarchiveFactory({
    wasmBinary: wasm,
    locateFile: (path) => path,
    print: () => {},
    printErr: () => {},
  });
  Module.runCode = {
    malloc: Module._malloc,
    free: Module._free,
    openArchive: Module.cwrap("archive_open", "number", ["number", "number", "string", "string"]),
    getNextEntry: Module.cwrap("get_next_entry", "number", ["number"]),
    getFileData: Module.cwrap("get_filedata", "number", ["number", "number"]),
    skipEntry: Module.cwrap("archive_read_data_skip", "number", ["number"]),
    closeArchive: Module.cwrap("archive_close", null, ["number"]),
    getEntrySize: Module.cwrap("archive_entry_size", "number", ["number"]),
    getEntryName: Module.cwrap("archive_entry_pathname", "string", ["number"]),
    getEntryType: Module.cwrap("archive_entry_filetype", "number", ["number"]),
    getError: Module.cwrap("archive_error_string", "string", ["number"]),
  };
  return Module;
}

const AE_IFDIR = 0o040000;

function loadFilePtr(bytes) {
  const ptr = Module.runCode.malloc(bytes.length);
  Module.HEAPU8.set(bytes, ptr);
  return ptr;
}

function openArc(ptr, length) {
  const archive = Module.runCode.openArchive(ptr, length, "", "en_US.UTF-8");
  if (!archive) throw new Error("보관 파일을 열 수 없습니다.");
  return archive;
}

function getHandle(id) {
  const h = handles.get(id);
  if (!h) throw new Error("보관 파일이 닫혀 있습니다.");
  return h;
}

function listEntries(bytes) {
  const ptr = loadFilePtr(bytes);
  let archive = 0;
  const out = [];
  try {
    archive = openArc(ptr, bytes.length);
    while (true) {
      const entry = Module.runCode.getNextEntry(archive);
      if (!entry) break;
      const typ = Module.runCode.getEntryType(entry);
      const path = Module.runCode.getEntryName(entry) || "";
      const size = Number(Module.runCode.getEntrySize(entry)) || 0;
      const isDir = (typ === AE_IFDIR) || /\/$/.test(path);
      out.push({ path, size, dir: !!isDir });
      Module.runCode.skipEntry(archive);
    }
  } finally {
    try { if (archive) Module.runCode.closeArchive(archive); } catch (_) {}
    try { Module._free(ptr); } catch (_) {}
  }
  return out;
}

function extractPath(bytes, targetPath) {
  const ptr = loadFilePtr(bytes);
  let archive = 0;
  try {
    archive = openArc(ptr, bytes.length);
    while (true) {
      const entry = Module.runCode.getNextEntry(archive);
      if (!entry) break;
      const path = Module.runCode.getEntryName(entry) || "";
      const size = Number(Module.runCode.getEntrySize(entry)) || 0;
      if (path !== targetPath) {
        Module.runCode.skipEntry(archive);
        continue;
      }
      if (size > 256 * 1024 * 1024) throw new Error("항목이 너무 커서 열 수 없습니다.");
      const fptr = Module.runCode.getFileData(archive, size);
      if (fptr < 0) throw new Error(Module.runCode.getError(archive) || "항목을 풀 수 없습니다.");
      const data = Module.HEAPU8.slice(fptr, fptr + size);
      try { Module._free(fptr); } catch (_) {}
      return data;
    }
    throw new Error("보관 파일에서 항목을 찾지 못했습니다.");
  } finally {
    try { if (archive) Module.runCode.closeArchive(archive); } catch (_) {}
    try { Module._free(ptr); } catch (_) {}
  }
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  const { id, cmd } = msg;
  try {
    if (cmd === "initScript") {
      self.LIBARCHIVE_SCRIPT_DIR = msg.scriptDir || self.location.href;
      importScripts(msg.factoryUrl);
      self.postMessage({ id, type: "ok" });
      return;
    }
    if (cmd === "load") {
      await ensureModule(msg.wasm);
      self.postMessage({ id, type: "ok" });
      return;
    }
    if (!Module) throw new Error("압축 엔진이 아직 준비되지 않았습니다.");
    if (cmd === "open") {
      const bytes = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data);
      if (!bytes.length) throw new Error("파일이 비어 있습니다.");
      const entries = listEntries(bytes);
      const handle = hid++;
      handles.set(handle, { bytes });
      self.postMessage({ id, type: "ok", handle, entries });
      return;
    }
    if (cmd === "extract") {
      const h = getHandle(msg.handle);
      const data = extractPath(h.bytes, msg.path);
      self.postMessage({ id, type: "ok", data }, [data.buffer]);
      return;
    }
    if (cmd === "close") {
      handles.delete(msg.handle);
      self.postMessage({ id, type: "ok" });
      return;
    }
    throw new Error("알 수 없는 명령입니다.");
  } catch (e) {
    self.postMessage({ id, type: "error", error: String(e && e.message ? e.message : e) });
  }
};
