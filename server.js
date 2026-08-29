"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { URL } = require("node:url");
const { spawn, spawnSync } = require("node:child_process");

const PORT = Number(process.env.SUBTITLE_PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.resolve(process.env.VIDEO_NOTE_DATA_DIR || path.join(__dirname, "data"));
const NOTES_DIR = path.join(DATA_DIR, "notes");
const TASKS_DIR = path.join(DATA_DIR, "tasks");
const EXPORTS_DIR = path.join(DATA_DIR, "exports");
const LOGS_DIR = path.join(DATA_DIR, "logs");
const TEMP_DIR = path.join(DATA_DIR, "tmp");
const ASR_TEMP_DIR = path.join(TEMP_DIR, "asr");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const AUDIO_CACHE_DIR = path.join(MEDIA_DIR, "audio");
const VIDEO_CACHE_DIR = path.join(MEDIA_DIR, "video");
const MODEL_CACHE_DIR = path.join(DATA_DIR, "models", "funasr");
const ASR_WORKER_FILE = path.join(__dirname, "workers", "funasr_worker.py");
const NOTE_INDEX_FILE = path.join(DATA_DIR, "notes-index.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const CODEX_LOG_FILE = path.join(DATA_DIR, "codex-file-operations.jsonl");
const GENERATION_LOG_FILE = path.join(LOGS_DIR, "generation.jsonl");
const OPERATION_LOG_FILE = path.join(LOGS_DIR, "operations.jsonl");

const BILIBILI_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  Referer: "https://www.bilibili.com/"
};

const DOUYIN_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  Referer: "https://www.douyin.com/"
};

const DEFAULT_HEADERS = BILIBILI_HEADERS;

const DEFAULT_SETTINGS = {
  aiBaseUrl: "",
  aiProvider: "",
  aiModel: "",
  obsidianVaultPath: "",
  obsidianFolder: "视频笔记",
  asrPythonPath: path.join(__dirname, ".venv", "bin", "python"),
  asrModel: "paraformer-zh",
  asrVadModel: "fsmn-vad",
  asrPuncModel: "ct-punc",
  speakerModel: "cam++",
  asrDevice: "cpu",
  asrModelDir: MODEL_CACHE_DIR,
  asrCpuThreads: Math.max(1, Math.min(6, os.cpus().length || 4)),
  speakerMergeGapSeconds: 1.5,
  speakerMaxSegmentSeconds: 20,
  speakerMinOverlapRatio: 0.35,
  speakerLowConfidence: 0.55,
  speakerAmbiguityRatio: 0.6
};

// 大纲是导航摘要，不需要把每一条字幕都原样送给模型。
// 这个上限刻意低于底座 20000 字符限制，给 JSON 外壳和系统提示词留出余量。
const OUTLINE_TRANSCRIPT_MAX_CHARS = 9000;
const OUTLINE_RESULT_MAX_CHARS = 3200;
// 底座当前已知的请求上限约为 20000 字符。给系统提示、JSON 外壳和上游代理留出余量，
// 所有 AI 原文请求统一在这个预算内按字幕完整片段切分；不会在一句字幕中间硬切。
const AI_CHUNK_MAX_CHARS = 9000;
const AI_CHUNK_TEXT_MAX_CHARS = 7200;
const AI_CHUNK_PAYLOAD_MAX_CHARS = 7600;
const AI_CHUNK_MAX_SEGMENTS = 80;
// 润色不再要求模型逐条复写时间轴。一个字幕源只发一次紧凑全文，
// 模型返回“原文起止序号 + 段落正文”，完整性由本地范围校验保证。
// 超过底座安全上限时明确阻止，不为适配接口偷偷降质或拆成几十次付费调用。
const POLISH_SINGLE_CALL_MAX_CHARS = 19500;
const POLISH_BLOCK_TARGET_CHARS = 190;
const POLISH_BLOCK_MIN_CHARS = 120;
const POLISH_BLOCK_MAX_CHARS = 280;
const POLISH_REQUEST_TARGET_CHARS = 3400;
const POLISH_MAX_API_CALLS = 5;
const AI_MAX_OUTLINE_CHUNKS = 80;
const AI_MAX_MINDMAP_NODES = 10;
const AI_MAX_OUTLINE_NODES = 12;
// 知识资料整理只允许 1-5 次付费请求。模型只接收正文、时间和说话人；
// 大量 sourceSegmentIds 继续留在本地快照中做 100% 覆盖核对，不再每次重复发给 API。
const KNOWLEDGE_REQUEST_TARGET_CHARS = 8500;
const KNOWLEDGE_REQUEST_MAX_CHARS = 12000;
const KNOWLEDGE_MAX_API_CALLS = 5;
const POLISHED_PARAGRAPH_MAX_CHARS = 460;
const POLISHED_PARAGRAPH_MAX_SECONDS = 90;
const POLISHED_PARAGRAPH_MAX_SENTENCES = 8;
const POLISHED_PARAGRAPH_MAX_GAP_SECONDS = 5;
const POLISH_MIN_PUNCTUATION_PER_100_CJK = 1.5;
const POLISH_MAX_UNPUNCTUATED_CJK_RUN = 90;
const POLISH_MAX_IDENTICAL_RATIO_FOR_RAW_INPUT = 0.75;
const KNOWLEDGE_SCHEMA_VERSION = 1;
let ytDlpMetadataOverride = null;

class AppError extends Error {
  constructor(code, message, details = {}, statusCode = 400) {
    super(message);
    this.code = code;
    this.details = details;
    this.statusCode = statusCode;
  }
}

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function safeString(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function safeSlug(value, fallback = "note") {
  const output = safeString(value, fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/[\s\u3000]+/g, " ")
    .trim()
    .slice(0, 90);
  return output || fallback;
}

function ensureDirectories() {
  for (const directory of [DATA_DIR, NOTES_DIR, TASKS_DIR, EXPORTS_DIR, LOGS_DIR, TEMP_DIR, ASR_TEMP_DIR, MEDIA_DIR, AUDIO_CACHE_DIR, VIDEO_CACHE_DIR, MODEL_CACHE_DIR]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return clone(fallback);
  }
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function appendJsonLine(filePath, value) {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function redactLogText(value, maxLength = 360) {
  return safeString(value)
    .replace(/(?:SESSDATA|cookie|api[_ -]?key|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, (match) => match.length > 220 ? `${match.slice(0, 220)}…` : match)
    .slice(0, maxLength);
}

function readableGenerationError(error) {
  const message = redactLogText(error?.message || error || "");
  const code = safeString(error?.code);
  if (code === "AI_CLOUDFLARE_524" || /error[_ ]?524|origin_response_timeout|cloudflare[^\n]*524/i.test(message)) {
    return { code: code || "AI_CLOUDFLARE_524", message: "AI 上游等待超时（Cloudflare 524），已完成的内容仍会保留；请稍后重试。" };
  }
  if (code === "AI_UPSTREAM_DISCONNECTED" || /server disconnected|socket hang up|connection reset/i.test(message)) {
    return { code: code || "AI_UPSTREAM_DISCONNECTED", message: "AI 上游连接中断，已完成的内容仍会保留；请稍后重试。" };
  }
  if (/文本过长|超过后端上限|too (?:long|large)/i.test(message)) {
    return { code: code || "AI_LEGACY_INPUT_TOO_LONG", message: "旧任务因整段内容超过上游长度限制而失败；新版会自动按完整字幕片段分块。" };
  }
  return message ? { code: code || "AI_FAILED", message } : null;
}

function safeOperationDetails(value, depth = 0) {
  if (depth > 2 || value === null || value === undefined) return value === null ? null : undefined;
  if (typeof value === "string") return redactLogText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeOperationDetails(item, depth + 1));
  if (typeof value !== "object") return undefined;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    if (/(sessdata|cookie|api[_ -]?key|authorization|token|secret|prompt|messages?)/i.test(key)) {
      output[key] = "[redacted]";
      continue;
    }
    const next = safeOperationDetails(item, depth + 1);
    if (next !== undefined) output[key] = next;
  }
  return output;
}

function appendOperationEvent(noteId, event, details = {}) {
  try {
    appendJsonLine(OPERATION_LOG_FILE, {
      id: id("operation"),
      noteId: safeString(noteId),
      event: safeString(event),
      details: safeOperationDetails(details),
      createdAt: now()
    });
  } catch (error) {
    // 操作日志是审计辅助，写失败不能阻断创建、保存、导出等主流程。
    console.error(`[operation-log] ${error.message}`);
  }
}

function listOperationLogs({ noteId = "", from = "", to = "", limit = 200 } = {}) {
  const fromTime = Date.parse(from) || 0;
  const toTime = Date.parse(to) || Number.POSITIVE_INFINITY;
  const maxItems = Math.max(1, Math.min(1000, Number(limit) || 200));
  return readJsonLines(OPERATION_LOG_FILE)
    .filter((event) => {
      if (noteId && event.noteId !== noteId) return false;
      const timestamp = Date.parse(event.createdAt) || 0;
      return timestamp >= fromTime && timestamp <= toTime;
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, maxItems);
}

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((value) => value && typeof value === "object");
  } catch {
    return [];
  }
}

function appendGenerationEvent(task, event) {
  if (task.type !== "analysis") return;
  try {
    appendJsonLine(GENERATION_LOG_FILE, {
      id: id("generation"),
      taskId: task.id,
      noteId: task.noteId,
      event,
      status: task.status,
      operation: safeString(task.meta?.operation),
      engine: safeString(task.meta?.engine),
      provider: safeString(task.meta?.provider),
      model: safeString(task.meta?.model),
      pageScope: safeString(task.meta?.pageScope || "current"),
      trackScope: safeString(task.meta?.trackScope || "current"),
      progress: Number(task.progress || 0),
      message: safeString(task.message),
      metrics: clone(task.metrics || null),
      chunks: Array.isArray(task.chunks) ? task.chunks.map((chunk) => ({
        id: chunk.id,
        index: chunk.index,
        status: chunk.status,
        inputChars: chunk.inputChars,
        receivedOutputChars: chunk.receivedOutputChars,
        outputChars: chunk.outputChars,
        error: chunk.error ? {
          code: safeString(chunk.error.code),
          message: redactLogText(chunk.error.message)
        } : null
      })) : [],
      error: task.error ? {
        code: safeString(task.error.code),
        message: redactLogText(task.error.message)
      } : null,
      result: event === "completed" ? clone(task.result) : null,
      createdAt: now()
    });
  } catch (error) {
    // 日志不能阻断 AI 任务本身；任务状态仍然以 task 文件为准。
    console.error(`[generation-log] ${error.message}`);
  }
}

function taskToGenerationEvent(task) {
  return {
    id: `legacy_${task.id}`,
    taskId: task.id,
    noteId: task.noteId,
    event: "snapshot",
    status: task.status,
    operation: safeString(task.meta?.operation),
    engine: safeString(task.meta?.engine),
    provider: safeString(task.meta?.provider),
    model: safeString(task.meta?.model),
    pageScope: safeString(task.meta?.pageScope || "current"),
    trackScope: safeString(task.meta?.trackScope || "current"),
    progress: Number(task.progress || 0),
    message: safeString(task.message),
    metrics: clone(task.metrics || null),
    chunks: Array.isArray(task.chunks) ? task.chunks.map((chunk) => ({
      id: chunk.id,
      index: chunk.index,
      status: chunk.status,
      inputChars: chunk.inputChars,
      receivedOutputChars: chunk.receivedOutputChars,
      outputChars: chunk.outputChars,
      error: chunk.error ? {
        code: safeString(chunk.error.code),
        message: redactLogText(chunk.error.message)
      } : null
    })) : [],
    error: task.error ? {
      code: safeString(task.error.code),
      message: redactLogText(task.error.message)
    } : null,
    result: clone(task.result),
    createdAt: task.updatedAt || task.createdAt || now()
  };
}

function listGenerationLogs(noteId) {
  const events = readJsonLines(GENERATION_LOG_FILE).filter((event) => event.noteId === noteId);
  const knownTaskIds = new Set(events.map((event) => event.taskId));
  for (const filename of fs.readdirSync(TASKS_DIR).filter((name) => name.endsWith(".json"))) {
    const task = readJsonFile(path.join(TASKS_DIR, filename), null);
    if (task?.type === "analysis" && task.noteId === noteId && !knownTaskIds.has(task.id)) {
      events.push(taskToGenerationEvent(task));
    }
  }

  const grouped = new Map();
  for (const event of events) {
    if (!event.taskId) continue;
    const current = grouped.get(event.taskId) || { taskId: event.taskId, events: [] };
    current.events.push(event);
    grouped.set(event.taskId, current);
  }

  return [...grouped.values()]
    .map((item) => {
      const history = [...item.events].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      const first = history[0] || {};
      const latest = history[history.length - 1] || {};
      const taskSnapshot = readJsonFile(path.join(TASKS_DIR, `${item.taskId}.json`), null);
      return {
        ...latest,
        noteId,
        error: readableGenerationError(latest.error),
        retryable: ["failed", "interrupted", "crashed"].includes(latest.status)
          && Boolean(taskSnapshot?.analysis?.request && taskSnapshot?.analysis?.input),
        createdAt: first.createdAt || latest.createdAt || now(),
        updatedAt: latest.createdAt || first.createdAt || now(),
        eventCount: history.length,
        events: history.map((event) => ({
          event: event.event,
          status: event.status,
          progress: event.progress,
          message: event.message,
          createdAt: event.createdAt
        }))
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function migrateLegacyGenerationLogs() {
  try {
    const knownTaskIds = new Set(readJsonLines(GENERATION_LOG_FILE).map((event) => event.taskId));
    for (const filename of fs.readdirSync(TASKS_DIR).filter((name) => name.endsWith(".json"))) {
      const task = readJsonFile(path.join(TASKS_DIR, filename), null);
      if (task?.type !== "analysis" || knownTaskIds.has(task.id)) continue;
      appendJsonLine(GENERATION_LOG_FILE, taskToGenerationEvent(task));
      knownTaskIds.add(task.id);
    }
  } catch (error) {
    console.error(`[generation-log-migration] ${error.message}`);
  }
}

function loadSettings() {
  const stored = readJsonFile(SETTINGS_FILE, {});
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    aiBaseUrl: safeString(stored.aiBaseUrl || process.env.VIDEO_AI_BASE_URL || process.env.AI_BASE_URL),
    obsidianVaultPath: safeString(stored.obsidianVaultPath || process.env.OBSIDIAN_VAULT)
  };
}

function saveSettings(settings) {
  const next = {
    ...DEFAULT_SETTINGS,
    ...settings,
    aiBaseUrl: safeString(settings.aiBaseUrl),
    aiProvider: safeString(settings.aiProvider),
    aiModel: safeString(settings.aiModel),
    obsidianVaultPath: safeString(settings.obsidianVaultPath),
    obsidianFolder: safeString(settings.obsidianFolder || DEFAULT_SETTINGS.obsidianFolder),
    asrPythonPath: safeString(settings.asrPythonPath || DEFAULT_SETTINGS.asrPythonPath),
    asrModel: safeString(settings.asrModel || DEFAULT_SETTINGS.asrModel),
    asrVadModel: safeString(settings.asrVadModel || DEFAULT_SETTINGS.asrVadModel),
    asrPuncModel: safeString(settings.asrPuncModel || DEFAULT_SETTINGS.asrPuncModel),
    speakerModel: safeString(settings.speakerModel || DEFAULT_SETTINGS.speakerModel),
    asrDevice: ["cpu", "mps"].includes(safeString(settings.asrDevice)) ? safeString(settings.asrDevice) : "cpu",
    asrModelDir: safeString(settings.asrModelDir || DEFAULT_SETTINGS.asrModelDir),
    asrCpuThreads: Math.max(1, Math.min(16, Number(settings.asrCpuThreads) || DEFAULT_SETTINGS.asrCpuThreads)),
    speakerMergeGapSeconds: Math.max(0, Math.min(10, Number(settings.speakerMergeGapSeconds) || DEFAULT_SETTINGS.speakerMergeGapSeconds)),
    speakerMaxSegmentSeconds: Math.max(5, Math.min(120, Number(settings.speakerMaxSegmentSeconds) || DEFAULT_SETTINGS.speakerMaxSegmentSeconds)),
    speakerMinOverlapRatio: Math.max(0.05, Math.min(1, Number(settings.speakerMinOverlapRatio) || DEFAULT_SETTINGS.speakerMinOverlapRatio)),
    speakerLowConfidence: Math.max(0, Math.min(1, Number(settings.speakerLowConfidence) || DEFAULT_SETTINGS.speakerLowConfidence)),
    speakerAmbiguityRatio: Math.max(0.1, Math.min(1, Number(settings.speakerAmbiguityRatio) || DEFAULT_SETTINGS.speakerAmbiguityRatio))
  };
  writeJsonAtomic(SETTINGS_FILE, next);
  return next;
}

function loadIndex() {
  const value = readJsonFile(NOTE_INDEX_FILE, []);
  return Array.isArray(value) ? value : [];
}

function saveIndex(index) {
  writeJsonAtomic(NOTE_INDEX_FILE, index);
}

function notePath(noteId) {
  if (!/^note_[a-z0-9]+$/i.test(noteId)) {
    throw new AppError("INVALID_NOTE_ID", "笔记编号不正确。", {}, 400);
  }
  return path.join(NOTES_DIR, `${noteId}.json`);
}

function taskPath(taskId) {
  if (!/^task_[a-z0-9]+$/i.test(taskId)) {
    throw new AppError("INVALID_TASK_ID", "任务编号不正确。", {}, 400);
  }
  return path.join(TASKS_DIR, `${taskId}.json`);
}

function loadNote(noteId) {
  const note = readJsonFile(notePath(noteId), null);
  if (!note) {
    throw new AppError("NOTE_NOT_FOUND", "笔记不存在或已经被移除。", {}, 404);
  }
  return note;
}

function sourceProvider(value) {
  const source = value?.source && typeof value.source === "object" ? value.source : value || {};
  const explicit = safeString(source.provider).toLowerCase();
  if (["bilibili", "douyin", "local"].includes(explicit)) return explicit;
  if (safeString(source.bvid)) return "bilibili";
  if (/douyin\.com/i.test(safeString(source.url))) return "douyin";
  return "bilibili";
}

function sourceId(value) {
  const source = value?.source && typeof value.source === "object" ? value.source : value || {};
  return safeString(source.sourceId || source.videoId || source.itemId || source.bvid);
}

function sourceKey(value) {
  const provider = sourceProvider(value);
  const identifier = sourceId(value);
  return identifier ? `${provider}:${identifier}` : "";
}

function sourceDisplayId(value) {
  const provider = sourceProvider(value);
  const identifier = sourceId(value);
  return provider === "bilibili" ? identifier : provider === "douyin" ? `抖音 ${identifier}` : identifier;
}

function sourceCreatorLabel(value) {
  const provider = sourceProvider(value);
  return provider === "bilibili" ? "未知UP主" : provider === "douyin" ? "未知作者" : "未知来源";
}

function saveNote(note) {
  note.updatedAt = now();
  writeJsonAtomic(notePath(note.id), note);
  updateIndexForNote(note);
  return note;
}

function noteIndexRecord(note) {
  const provider = sourceProvider(note);
  const identifier = sourceId(note);
  return {
    id: note.id,
    title: note.title || note.source?.title || "未命名笔记",
    provider,
    sourceId: identifier,
    sourceKey: identifier ? `${provider}:${identifier}` : "",
    bvid: provider === "bilibili" ? identifier : "",
    cover: note.source?.cover || "",
    author: note.source?.author || sourceCreatorLabel(note),
    duration: Number(note.source?.duration || 0),
    tags: Array.isArray(note.tags) ? note.tags : [],
    pinned: Boolean(note.pinned),
    progress: Number(note.progress || 0),
    status: note.status || "ready",
    subtitleStatus: note.processing?.subtitle || "unknown",
    asrStatus: note.processing?.asr || "not_started",
    aiStatus: note.processing?.ai || "not_started",
    createdAt: note.createdAt || now(),
    updatedAt: note.updatedAt || now(),
    lastOpenedAt: note.lastOpenedAt || "",
    deletedAt: note.deletedAt || ""
  };
}

function updateIndexForNote(note) {
  const index = loadIndex();
  const record = noteIndexRecord(note);
  const position = index.findIndex((item) => item.id === note.id);
  if (position === -1) index.push(record);
  else index[position] = record;
  saveIndex(index);
}

function removeIndexForNote(noteId) {
  saveIndex(loadIndex().filter((item) => item.id !== noteId));
}

function sortNotes(items) {
  return [...items].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });
}

function json(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(body);
}

function text(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes = 12 * 1024 * 1024) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) {
      throw new AppError("BODY_TOO_LARGE", "请求内容太大了。", {}, 413);
    }
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new AppError("INVALID_BODY", "请求数据格式不正确。", {}, 400);
  }
}

async function fetchJson(endpoint, params = {}, headers = {}) {
  const requestUrl = new URL(endpoint);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      requestUrl.searchParams.set(key, String(value));
    }
  });

  let response;
  try {
    response = await fetch(requestUrl, {
      headers: { ...DEFAULT_HEADERS, ...headers },
      redirect: "follow",
      signal: AbortSignal.timeout(20000)
    });
  } catch (error) {
    throw new AppError("UPSTREAM_NETWORK", "连接B站失败，请检查网络或稍后重试。", { cause: error.message }, 502);
  }

  if (!response.ok) {
    throw new AppError("UPSTREAM_HTTP", `B站返回了 HTTP ${response.status}。`, { status: response.status, endpoint }, 502);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new AppError("UPSTREAM_JSON", "B站返回的数据不是有效 JSON。", { cause: error.message, endpoint }, 502);
  }
}

function bilibiliHeaders(sessdata = "") {
  const cookie = safeString(sessdata || process.env.BILI_SESSDATA);
  if (!cookie) return {};
  if (/[\r\n;]/.test(cookie)) {
    throw new AppError("INVALID_SESSION", "SESSDATA 格式不正确，请只粘贴 Cookie 的值。", {}, 400);
  }
  return { Cookie: `SESSDATA=${cookie}` };
}

function assertBilibiliResponse(payload, label) {
  if (!payload || payload.code !== 0 || !payload.data) {
    throw new AppError("BILIBILI_API", `${label}失败：${payload?.message || "未知错误"}。`, { upstreamCode: payload?.code }, 502);
  }
  return payload.data;
}

async function resolveBvid(input) {
  const raw = safeString(input);
  const directMatch = raw.match(/BV[a-zA-Z0-9]+/);
  if (directMatch) return directMatch[0];

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError("INVALID_URL", "请输入完整的B站视频链接。示例：https://www.bilibili.com/video/BV...。", {}, 400);
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    throw new AppError("INVALID_URL", "只支持 http 或 https 链接。", {}, 400);
  }

  let response;
  try {
    response = await fetch(parsed, {
      headers: DEFAULT_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    throw new AppError("SHORT_URL", "短链接解析失败，请改用完整的 B 站视频链接。", { cause: error.message }, 502);
  }

  const resolvedMatch = response.url.match(/BV[a-zA-Z0-9]+/);
  if (resolvedMatch) return resolvedMatch[0];
  throw new AppError("INVALID_URL", "没有在链接中找到 BV 号，请确认这是B站视频链接。", {}, 400);
}

function extractSharedUrl(input) {
  const raw = safeString(input);
  const match = raw.match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0].replace(/[，。！？、；;,.!?]+$/u, "") : raw;
}

function detectVideoProvider(input) {
  const raw = safeString(input);
  if (/BV[a-zA-Z0-9]+/.test(raw)) return "bilibili";
  const candidate = extractSharedUrl(raw);
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new AppError("INVALID_URL", "请粘贴 B站或抖音的视频链接。", {}, 400);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "b23.tv" || hostname === "bilibili.com" || hostname.endsWith(".bilibili.com")) return "bilibili";
  if (hostname === "douyin.com" || hostname.endsWith(".douyin.com") || hostname.endsWith(".iesdouyin.com")) return "douyin";
  throw new AppError("UNSUPPORTED_VIDEO_PROVIDER", "目前只支持 B站和抖音视频链接。", { hostname }, 400);
}

function normalizeSourceCredentials(value) {
  if (typeof value === "string") return { sessdata: safeString(value), browserCookies: "" };
  const browserCookies = safeString(value?.browserCookies).toLowerCase();
  if (browserCookies && !["chrome", "chromium", "edge", "safari", "firefox"].includes(browserCookies)) {
    throw new AppError("INVALID_BROWSER_COOKIE_SOURCE", "浏览器登录态来源不受支持。", {}, 400);
  }
  return { sessdata: safeString(value?.sessdata), browserCookies };
}

function douyinVideoIdFromUrl(input) {
  const raw = safeString(input);
  const match = raw.match(/(?:\/video\/|modal_id=|aweme_id=)(\d{8,})/i);
  return match?.[1] || "";
}

function douyinShareFallbackId(input) {
  try {
    const parsed = new URL(extractSharedUrl(input));
    const token = parsed.pathname.split("/").filter(Boolean).at(-1) || parsed.hostname;
    return `share-${safeSlug(token, sha256Json({ url: parsed.toString() }).slice(0, 12)).replace(/\s+/g, "-")}`;
  } catch {
    return `share-${sha256Json({ url: safeString(input) }).slice(0, 12)}`;
  }
}

async function resolveDouyinShareUrl(input) {
  const candidate = extractSharedUrl(input);
  if (douyinVideoIdFromUrl(candidate)) return candidate;
  try {
    const response = await fetch(candidate, {
      headers: DOUYIN_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(15000)
    });
    return response.url || candidate;
  } catch {
    return candidate;
  }
}

async function readDouyinMetadata(input, credentials = {}) {
  if (typeof ytDlpMetadataOverride === "function") return ytDlpMetadataOverride(input, credentials);
  const config = asrRuntimeConfig();
  if (!config.ytdlp) throw new AppError("YTDLP_NOT_FOUND", "没有找到 yt-dlp，暂时无法解析抖音视频。", {}, 503);
  const args = ["--no-config", "--no-playlist", "--skip-download", "--dump-single-json", "--no-warnings"];
  if (credentials.browserCookies) args.push("--cookies-from-browser", credentials.browserCookies);
  args.push(extractSharedUrl(input));
  const result = await runProcess(config.ytdlp, args, {
    errorCode: credentials.browserCookies ? "DOUYIN_METADATA_FAILED" : "DOUYIN_COOKIE_REQUIRED",
    errorMessage: credentials.browserCookies
      ? "抖音视频信息仍然无法读取；可以先创建笔记后拖入本地视频。"
      : "抖音限制了这次访问；可勾选临时读取浏览器登录态后重试。"
  });
  const lines = safeString(result.stdout).split(/\r?\n/).filter(Boolean);
  for (const line of lines.reverse()) {
    try { return JSON.parse(line); } catch { /* try previous line */ }
  }
  throw new AppError("DOUYIN_METADATA_INVALID", "抖音解析器没有返回有效的视频信息。", {}, 502);
}

async function readDouyinEmbedMetadata(videoId) {
  if (!/^\d{8,}$/.test(safeString(videoId))) return null;
  try {
    const endpoint = new URL("https://open.douyin.com/api/douyin/v1/video/get_iframe_by_video");
    endpoint.searchParams.set("video_id", videoId);
    const response = await fetch(endpoint, { headers: DOUYIN_HEADERS, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    const payload = await response.json();
    if (Number(payload?.err_no) !== 0 || !payload?.data?.iframe_code) return null;
    return {
      id: videoId,
      webpage_url: `https://www.douyin.com/video/${videoId}`,
      title: safeString(payload.data.video_title || `抖音视频 ${videoId}`),
      width: Number(payload.data.video_width || 0),
      height: Number(payload.data.video_height || 0),
      iframeCode: safeString(payload.data.iframe_code),
      partial: true
    };
  } catch {
    return null;
  }
}

async function loadDouyinSource(input, credentialInput = {}) {
  const credentials = normalizeSourceCredentials(credentialInput);
  const resolvedUrl = await resolveDouyinShareUrl(input);
  const metadataOverrideActive = typeof ytDlpMetadataOverride === "function";
  let metadata = null;
  let metadataError = null;
  try {
    metadata = await readDouyinMetadata(resolvedUrl, credentials);
  } catch (error) {
    metadataError = error;
  }
  let identifier = safeString(metadata?.id || douyinVideoIdFromUrl(metadata?.webpage_url) || douyinVideoIdFromUrl(resolvedUrl));
  if (!metadata && identifier && !metadataOverrideActive) metadata = await readDouyinEmbedMetadata(identifier);
  identifier = safeString(metadata?.id || identifier);
  const fallbackIdentifier = identifier || douyinShareFallbackId(resolvedUrl);
  const duration = Math.max(0, Number(metadata?.duration || 0));
  const canonicalUrl = safeString(metadata?.webpage_url || (identifier ? `https://www.douyin.com/video/${identifier}` : resolvedUrl));
  const page = {
    page: 1,
    cid: 0,
    part: "抖音视频",
    duration,
    needLoginSubtitle: false,
    subtitles: []
  };
  return {
    ok: true,
    fetchedAt: now(),
    authUsed: Boolean(credentials.browserCookies),
    subtitleStatus: "missing",
    metadataStatus: metadata && !metadata.partial ? "ready" : "partial",
    metadataError: metadataError ? redactLogText(metadataError.message) : "",
    source: {
      provider: "douyin",
      sourceId: fallbackIdentifier,
      videoId: identifier,
      title: safeString(metadata?.title || metadata?.description || `抖音视频 ${fallbackIdentifier}`),
      author: safeString(metadata?.uploader || metadata?.channel || "未知作者"),
      cover: safeString(metadata?.thumbnail),
      description: safeString(metadata?.description),
      duration,
      url: canonicalUrl,
      originalUrl: extractSharedUrl(input)
    },
    pages: [page],
    stats: { pageCount: 1, subtitleTrackCount: 0, segmentCount: 0 },
    loginRequired: false
  };
}

async function getVideoInfo(bvid, headers = {}) {
  const payload = await fetchJson("https://api.bilibili.com/x/web-interface/view", { bvid }, headers);
  return assertBilibiliResponse(payload, "视频信息读取");
}

async function getPlayerInfo(bvid, cid, headers = {}) {
  const endpoints = [
    "https://api.bilibili.com/x/player/wbi/v2",
    "https://api.bilibili.com/x/player/v2"
  ];
  let lastError;
  for (const endpoint of endpoints) {
    try {
      const payload = await fetchJson(endpoint, { bvid, cid }, headers);
      return assertBilibiliResponse(payload, "播放器信息读取");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new AppError("PLAYER_API", "播放器信息读取失败。", {}, 502);
}

function normalizeSubtitleTrack(track, pageNumber, trackNumber) {
  const aiType = Number(track.ai_type || 0);
  const aiStatus = Number(track.ai_status || 0);
  const isAI = aiType > 0 || aiStatus > 0;
  const rawUrl = safeString(track.subtitle_url);
  const idValue = String(track.id_str || track.id || `${pageNumber}-${trackNumber}`);
  return {
    id: idValue,
    language: track.lan || "unknown",
    languageName: track.lan_doc || track.lan || "未知语言",
    label: isAI ? "AI 字幕" : "公开字幕",
    isAI,
    aiType,
    aiStatus,
    subtitleUrl: rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl,
    body: [],
    segments: []
  };
}

async function hydrateTrack(track, pageNumber, headers = {}) {
  if (!track.subtitleUrl) return track;
  // AI 字幕的正文地址有时也需要登录态；不能只把 Cookie 用在播放器信息接口。
  const subtitlePayload = await fetchJson(track.subtitleUrl, {}, headers);
  const body = Array.isArray(subtitlePayload?.body) ? subtitlePayload.body : [];
  const normalizedBody = body
    .map((item, index) => ({
      index,
      from: Number(item.from || 0),
      to: Number(item.to || 0),
      content: safeString(item.content)
    }))
    .filter((item) => item.content);
  return {
    ...track,
    body: normalizedBody,
    segments: normalizedBody.map((item, index) => ({
      id: `p${pageNumber}-${safeSlug(track.id, "track")}-${index}`,
      from: item.from,
      to: item.to,
      text: item.content,
      content: item.content
    }))
  };
}

async function loadBilibiliSource(input, sessdata = "") {
  const bvid = await resolveBvid(input);
  const headers = bilibiliHeaders(sessdata);
  const video = await getVideoInfo(bvid, headers);
  const rawPages = Array.isArray(video.pages) && video.pages.length
    ? video.pages
    : [{ page: 1, cid: video.cid, part: video.title, duration: video.duration }];

  const pages = await Promise.all(rawPages.map(async (page) => {
    try {
      const player = await getPlayerInfo(bvid, page.cid, headers);
      const rawTracks = player.subtitle?.subtitles || [];
      const subtitles = [];
      for (let index = 0; index < rawTracks.length; index += 1) {
        const track = normalizeSubtitleTrack(rawTracks[index], page.page, index);
        try {
          subtitles.push(await hydrateTrack(track, page.page, headers));
        } catch (error) {
          subtitles.push({ ...track, fetchError: error.message });
        }
      }
      return {
        page: Number(page.page || 1),
        cid: Number(page.cid || 0),
        part: safeString(page.part || `P${page.page}`),
        duration: Number(page.duration || 0),
        needLoginSubtitle: Boolean(player.need_login_subtitle),
        subtitles
      };
    } catch (error) {
      return {
        page: Number(page.page || 1),
        cid: Number(page.cid || 0),
        part: safeString(page.part || `P${page.page}`),
        duration: Number(page.duration || 0),
        needLoginSubtitle: false,
        subtitles: [],
        fetchError: error.message
      };
    }
  }));

  const subtitleCount = pages.reduce((sum, page) => sum + page.subtitles.length, 0);
  const segmentCount = pages.reduce(
    (sum, page) => sum + page.subtitles.reduce((pageSum, track) => pageSum + track.body.length, 0),
    0
  );
  const loginRequired = pages.some((page) => page.needLoginSubtitle);
  const subtitleStatus = segmentCount ? "ready" : loginRequired ? "login_required" : "missing";

  return {
    ok: true,
    fetchedAt: now(),
    authUsed: Boolean(headers.Cookie),
    subtitleStatus,
    source: {
      provider: "bilibili",
      sourceId: bvid,
      bvid,
      title: safeString(video.title || "未命名视频"),
      author: safeString(video.owner?.name || "未知UP主"),
      cover: safeString(video.pic),
      description: safeString(video.desc),
      duration: Number(video.duration || 0),
      url: `https://www.bilibili.com/video/${bvid}`,
      aid: Number(video.aid || 0)
    },
    pages,
    stats: {
      pageCount: pages.length,
      subtitleTrackCount: subtitleCount,
      segmentCount
    },
    loginRequired
  };
}

async function loadSource(input, credentialInput = {}) {
  const provider = detectVideoProvider(input);
  const credentials = normalizeSourceCredentials(credentialInput);
  return provider === "douyin"
    ? loadDouyinSource(input, credentials)
    : loadBilibiliSource(input, credentials.sessdata);
}

async function loadSubtitles(input, sessdata = "") {
  const result = await loadSource(input, sessdata);
  if (!result.stats.subtitleTrackCount || !result.stats.segmentCount) {
    throw new AppError(
      "NO_SUBTITLE",
      result.loginRequired
        ? "B站提示字幕需要登录。展开网页里的登录设置，填入你自己的 SESSDATA 后再试。"
        : sourceProvider(result) === "douyin"
          ? "抖音没有可稳定读取的平台字幕，请创建笔记后启动本地 ASR。"
          : "这个视频目前没有拿到可公开读取的字幕或 AI 字幕。",
      {
        provider: sourceProvider(result),
        sourceId: sourceId(result),
        bvid: result.source.bvid,
        loginRequired: result.loginRequired,
        pages: result.pages.map(({ page, part, needLoginSubtitle, subtitles }) => ({
          page,
          part,
          needLoginSubtitle,
          subtitleCount: subtitles.length
        }))
      },
      422
    );
  }
  return result;
}

function firstAvailableTrack(note, pageIndex = 0, trackIndex = 0) {
  const pages = note.transcript?.original?.pages || [];
  const page = pages[pageIndex] || pages[0];
  if (!page) return null;
  const tracks = page.subtitles || [];
  return tracks[trackIndex] || tracks[0] || null;
}

function flattenSegments(track) {
  return (track?.segments || track?.body || []).map((segment, index) => ({
    id: segment.id || `segment-${index}`,
    from: Number(segment.from || 0),
    to: Number(segment.to || 0),
    text: safeString(segment.text || segment.content)
  })).filter((segment) => segment.text);
}

function buildNoteFromSource(result, options = {}) {
  const createdAt = now();
  const sourcePages = result.pages.map((page) => ({
    page: page.page,
    cid: page.cid,
    part: page.part,
    duration: page.duration
  }));
  const originalPages = clone(result.pages);
  return {
    schemaVersion: 2,
    id: id("note"),
    title: result.source.title || "未命名笔记",
    tags: Array.isArray(options.tags) ? options.tags.map((tag) => safeString(tag)).filter(Boolean).slice(0, 20) : [],
    pinned: false,
    progress: 0,
    createdAt,
    updatedAt: createdAt,
    lastOpenedAt: "",
    status: result.stats.segmentCount ? "ready" : "waiting_asr",
    source: { ...clone(result.source), pages: sourcePages },
    transcript: {
      original: {
        source: result.stats.segmentCount ? sourceProvider(result) : "pending",
        status: result.stats.segmentCount ? "ready" : "missing",
        pages: originalPages
      },
      polished: {
        status: "not_generated",
        pageIndex: 0,
        trackId: "",
        segments: [],
        variants: {},
        generatedAt: "",
        engine: "",
        provider: "",
        model: ""
      },
      speaker: {
        status: "not_generated",
        source: "",
        variants: {},
        generatedAt: ""
      }
    },
    outline: { status: "not_generated", tree: null, generatedAt: "", engine: "", model: "" },
    mindmap: { status: "not_generated", tree: null, generatedAt: "", engine: "", model: "" },
    knowledge: {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      status: "not_started",
      material: null,
      audit: { status: "not_started", issues: [], checkedAt: "" },
      synthesis: null
    },
    record: { html: "", plainText: "", revision: 0, updatedAt: "" },
    speaker: { status: "not_started", segments: [], variants: {}, labels: {} },
    processing: {
      subtitle: result.subtitleStatus,
      ai: "not_started",
      asr: "not_started",
      diarization: "not_started"
    },
    settings: {
      processingEngine: safeString(options.engine || "api") || "api",
      provider: safeString(options.provider),
      model: safeString(options.model)
    }
  };
}

async function refreshNoteSubtitles(note, input, sessdata = "") {
  const credentials = typeof sessdata === "object" ? sessdata : { sessdata };
  const result = await loadSource(input || note.source?.url || sourceId(note), credentials);
  const sameDouyinVideo = sourceProvider(note) === "douyin"
    && sourceProvider(result) === "douyin"
    && (!safeString(note.source?.videoId) || !safeString(result.source?.videoId) || safeString(note.source.videoId) === safeString(result.source.videoId));
  if (sourceKey(result) !== sourceKey(note) && !sameDouyinVideo) {
    throw new AppError("NOTE_SOURCE_MISMATCH", "刷新字幕时发现视频不是当前笔记对应的视频。", {
      expected: sourceKey(note),
      actual: sourceKey(result)
    }, 409);
  }

  if (sourceProvider(note) === "douyin") {
    const sourcePages = result.pages.map((page) => ({ page: page.page, cid: page.cid, part: page.part, duration: page.duration }));
    note.source = { ...note.source, ...clone(result.source), pages: sourcePages };
    note.schemaVersion = Math.max(2, Number(note.schemaVersion || 1));
    return { note: saveNote(note), result, preserved: true };
  }

  const hadOriginalSegments = (note.transcript?.original?.pages || [])
    .some((page) => (page.subtitles || []).some((track) => flattenSegments(track).length > 0));
  // 刷新失败不能损坏已经成功保存的原文；只有原本就没有字幕时才更新为待处理状态。
  if (!result.stats.segmentCount && hadOriginalSegments) {
    return { note, result, preserved: true };
  }

  const sourcePages = result.pages.map((page) => ({
    page: page.page,
    cid: page.cid,
    part: page.part,
    duration: page.duration
  }));
  note.source = { ...note.source, ...clone(result.source), pages: sourcePages };
  note.transcript = note.transcript || {};
  note.transcript.original = {
    ...(note.transcript.original || {}),
    source: result.stats.segmentCount ? sourceProvider(result) : "pending",
    status: result.stats.segmentCount ? "ready" : "missing",
    pages: clone(result.pages),
    fetchedAt: result.fetchedAt
  };
  note.processing = {
    ...(note.processing || {}),
    subtitle: result.subtitleStatus
  };
  note.status = result.stats.segmentCount ? "ready" : "waiting_asr";
  invalidateKnowledge(note, "原始字幕已重新获取");
  return { note: saveNote(note), result };
}

function findNoteBySource(provider, identifier) {
  const expected = `${safeString(provider).toLowerCase()}:${safeString(identifier)}`;
  const item = loadIndex().find((record) => {
    const recordProvider = safeString(record.provider || (record.bvid ? "bilibili" : "bilibili"));
    const recordId = safeString(record.sourceId || record.bvid);
    return `${recordProvider}:${recordId}` === expected;
  });
  return item ? loadNote(item.id) : null;
}

function findNoteByBvid(bvid) {
  return findNoteBySource("bilibili", bvid);
}

function getVisibleNotes(query = "", tag = "", includeDeleted = false) {
  const normalizedQuery = safeString(query).toLowerCase();
  const normalizedTag = safeString(tag).toLowerCase();
  const notes = loadIndex().filter((item) => includeDeleted || !item.deletedAt);
  return sortNotes(notes.filter((item) => {
    const haystack = [item.title, item.sourceId, item.bvid, item.provider, item.author, ...(item.tags || [])].join(" ").toLowerCase();
    const matchesQuery = !normalizedQuery || haystack.includes(normalizedQuery);
    const matchesTag = !normalizedTag || (item.tags || []).some((value) => String(value).toLowerCase() === normalizedTag);
    return matchesQuery && matchesTag;
  }));
}

function updateNoteMeta(note, body) {
  note.settings = note.settings || { processingEngine: "api", provider: "", model: "" };
  if (body.title !== undefined) note.title = safeString(body.title).slice(0, 120) || note.source.title || "未命名笔记";
  if (body.tags !== undefined) {
    note.tags = Array.isArray(body.tags)
      ? [...new Set(body.tags.map((tag) => safeString(tag)).filter(Boolean))].slice(0, 20)
      : [];
  }
  if (body.pinned !== undefined) note.pinned = Boolean(body.pinned);
  if (body.progress !== undefined) note.progress = Math.max(0, Math.min(100, Number(body.progress) || 0));
  if (body.processingEngine !== undefined) {
    const engine = safeString(body.processingEngine);
    if (["api", "codex", "none"].includes(engine)) note.settings.processingEngine = engine;
  }
  if (body.processingProvider !== undefined) note.settings.provider = safeString(body.processingProvider).slice(0, 80);
  if (body.processingModel !== undefined) note.settings.model = safeString(body.processingModel).slice(0, 160);
  note.lastOpenedAt = body.lastOpenedAt || note.lastOpenedAt;
  return saveNote(note);
}

function sanitizeHtml(html) {
  let output = safeString(html);
  output = output.replace(/<\/?(script|style|iframe|object|embed|form|input|button|textarea|link|meta)[^>]*>/gi, "");
  output = output.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  output = output.replace(/javascript\s*:/gi, "");
  output = output.replace(/<(?!\/?(?:p|div|br|strong|b|em|i|s|strike|u|h1|h2|h3|ul|ol|li|span)(?:\s|\/?>))/gi, "&lt;");
  return output.slice(0, 500000);
}

function htmlToPlainText(html) {
  return safeString(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h1|h2|h3|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToMarkdown(html) {
  let output = sanitizeHtml(html);
  output = output
    .replace(/<h1[^>]*>(.*?)<\/h1>/gis, "# $1\n\n")
    .replace(/<h2[^>]*>(.*?)<\/h2>/gis, "## $1\n\n")
    .replace(/<h3[^>]*>(.*?)<\/h3>/gis, "### $1\n\n")
    .replace(/<(strong|b)[^>]*>(.*?)<\/\1>/gis, "**$2**")
    .replace(/<(em|i)[^>]*>(.*?)<\/\1>/gis, "*$2*")
    .replace(/<(s|strike)[^>]*>(.*?)<\/\1>/gis, "~~$2~~")
    .replace(/<u[^>]*>(.*?)<\/u>/gis, "$1")
    .replace(/<li[^>]*>(.*?)<\/li>/gis, "- $1\n")
    .replace(/<br\s*\/?>(\s*)/gi, "\n")
    .replace(/<\/(p|div)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return output;
}

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? [hours, minutes, secs].map((item) => String(item).padStart(2, "0")).join(":")
    : [minutes, secs].map((item) => String(item).padStart(2, "0")).join(":");
}

function segmentsToMarkdown(note, title, segments = []) {
  if (!segments.length) return `## ${title}\n\n暂无内容。\n`;
  return `## ${title}\n\n${segments.map((segment) => `- [${formatTimestamp(segment.from)}](${videoTimeLink(note, segment)}) ${segment.text}`).join("\n")}\n`;
}

function yamlValue(value) {
  return JSON.stringify(safeString(value));
}

function videoTimeLink(note, segment) {
  if (sourceProvider(note) === "douyin") {
    const query = new URLSearchParams({ note: note.id, t: String(Math.floor(Number(segment?.from || 0))) });
    return `http://127.0.0.1:${PORT}/?${query.toString()}`;
  }
  try {
    const url = new URL(note.source?.url || `https://www.bilibili.com/video/${note.source?.bvid || ""}`);
    url.searchParams.set("p", String(Number(segment?.page || 1)));
    url.searchParams.set("t", String(Math.floor(Number(segment?.from || 0))));
    return url.toString();
  } catch {
    return `${safeString(note.source?.url)}?p=${Number(segment?.page || 1)}&t=${Math.floor(Number(segment?.from || 0))}`;
  }
}

function evidenceMarkdown(note, segmentIds, segmentMap) {
  return (Array.isArray(segmentIds) ? segmentIds : []).map((segmentId) => {
    const segment = segmentMap.get(segmentId);
    return segment ? `[▶ ${formatTimestamp(segment.from)}](${videoTimeLink(note, segment)})` : "";
  }).filter(Boolean).join(" ");
}

function outlineMarkdown(items, note, segmentMap, depth = 0) {
  return (Array.isArray(items) ? items : []).flatMap((item) => {
    const heading = `${"#".repeat(Math.min(6, 3 + depth))} ${safeString(item.title)}`;
    const lines = [heading, "", safeString(item.summary), ""];
    for (const point of item.keyPoints || []) lines.push(`- ${safeString(point)}`);
    const evidence = evidenceMarkdown(note, item.segmentIds, segmentMap);
    if (evidence) lines.push(`- 证据：${evidence}`);
    if ((item.keyPoints || []).length || evidence) lines.push("");
    lines.push(...outlineMarkdown(item.children, note, segmentMap, depth + 1));
    return lines;
  });
}

function mermaidMindmapLines(node, depth = 0) {
  if (!node || !safeString(node.label)) return [];
  const indent = "  ".repeat(depth + 1);
  const label = safeString(node.label).replace(/[\r\n()]/g, " ");
  return [`${indent}${depth === 0 ? "root" : ""}((${label}))`, ...(node.children || []).flatMap((child) => mermaidMindmapLines(child, depth + 1))];
}

function transcriptModeLabel(mode) {
  return mode === "speaker" ? "说话人版" : mode === "polished" ? "AI 润色版" : "原文";
}

function transcriptDetailsMarkdown(note, snapshot) {
  if (!snapshot?.segments?.length) return ["<details>", "<summary>锁定字幕快照</summary>", "", "当前还没有完整快照。", "", "</details>"];
  const groups = new Map();
  for (const segment of snapshot.segments) {
    const list = groups.get(segment.sourceKey) || [];
    list.push(segment);
    groups.set(segment.sourceKey, list);
  }
  const lines = ["<details>", `<summary>锁定字幕快照（${transcriptModeLabel(snapshot.transcriptMode)}）</summary>`, ""];
  for (const [sourceKey, segments] of groups) {
    const first = segments[0];
    lines.push(`### P${first.page} · ${first.track || first.trackId || sourceKey}`, "");
    for (const segment of segments) {
      const speaker = segment.speakerLabel ? `**${segment.speakerLabel}：**` : "";
      lines.push(`- [${formatTimestamp(segment.from)}](${videoTimeLink(note, segment)}) ${speaker}${safeString(segment.text)}`);
    }
    lines.push("");
  }
  lines.push("</details>");
  if (["polished", "speaker"].includes(snapshot.transcriptMode)) {
    lines.push("", "<details>", `<summary>原始字幕对照（${snapshot.transcriptMode === "speaker" ? "按说话人合并段落追溯" : "按润色段落追溯"}）</summary>`, "");
    for (const [sourceKey, segments] of groups) {
      const first = segments[0];
      lines.push(`### P${first.page} · ${first.track || first.trackId || sourceKey}`, "");
      for (const segment of segments) lines.push(`- [${formatTimestamp(segment.from)}](${videoTimeLink(note, segment)}) ${safeString(segment.originalText || segment.text)}`);
      lines.push("");
    }
    lines.push("</details>");
  }
  return lines;
}

function buildMarkdown(note) {
  const material = note.knowledge?.material;
  const synthesis = note.knowledge?.synthesis;
  let snapshotFresh = false;
  if (material?.snapshot?.snapshotHash) {
    try {
      const current = buildKnowledgeInput(note, {
        pageIndex: material.snapshot.selected?.pageIndex,
        trackIndex: material.snapshot.selected?.trackIndex,
        pageScope: material.snapshot.scope?.pageScope,
        trackScope: material.snapshot.scope?.trackScope,
        transcriptMode: material.snapshot.transcriptMode
      });
      snapshotFresh = current.snapshotHash === material.snapshot.snapshotHash;
    } catch {
      snapshotFresh = false;
    }
  }
  const ready = note.knowledge?.status === "ready"
    && snapshotFresh
    && note.knowledge?.audit?.status === "PASS"
    && synthesis?.materialHash
    && synthesis.materialHash === material?.materialHash;
  const snapshot = material?.snapshot;
  const segmentMap = new Map((snapshot?.segments || []).map((segment) => [segment.segmentId, segment]));
  const tags = [...new Set([...(note.tags || []), "视频笔记", ready ? "知识库" : "待处理"] )];
  const knowledgeHash = ready ? sha256Json(synthesis) : "";
  const lines = [
    "---",
    `title: ${yamlValue(note.title)}`,
    `type: ${yamlValue("video-knowledge-note")}`,
    `status: ${yamlValue(ready ? "ready" : "draft")}`,
    `platform: ${yamlValue(sourceProvider(note))}`,
    `source-id: ${yamlValue(sourceId(note))}`,
    ...(sourceProvider(note) === "bilibili" ? [`bvid: ${yamlValue(note.source?.bvid)}`] : []),
    `source: ${yamlValue(note.source?.url)}`,
    `creator: ${yamlValue(note.source?.author)}`,
    `created: ${yamlValue(note.createdAt)}`,
    `updated: ${yamlValue(note.updatedAt)}`,
    `video-note-id: ${yamlValue(note.id)}`,
    `transcript-mode: ${yamlValue(snapshot?.transcriptMode || "")}`,
    `material-hash: ${yamlValue(material?.materialHash || "")}`,
    `knowledge-hash: ${yamlValue(knowledgeHash)}`,
    "tags:",
    ...tags.map((tag) => `  - ${yamlValue(tag)}`),
    "---", "", `# ${note.title}`, ""
  ];
  if (!ready) {
    lines.push("> [!warning] 这是草稿总输出", "> API 资料尚未完整通过 Codex 核查，不应当作已发布的知识笔记。", "");
  }
  lines.push("## 来源与处理状态", "", `- 视频：[${safeString(note.source?.title || note.title)}](${safeString(note.source?.url)})`, `- 作者：${safeString(note.source?.author || "未知")}`, `- API 资料：${material?.completeness?.ready ? `完整（${material.completeness.completedChunkCount}/${material.completeness.chunkCount} 块）` : "未完整"}`, `- Codex 核查：${safeString(note.knowledge?.audit?.status || "未执行")}`, "");
  if (ready) {
    lines.push("## 一句话总结", "", synthesis.oneSentenceSummary || "未填写。", "", "## 为什么值得沉淀", "", synthesis.whyItMatters || "未填写。", "", "## 核心结论", "");
    for (const item of synthesis.coreConclusions || []) {
      const speaker = item.speakerLabel ? `（${item.speakerLabel}）` : "";
      lines.push(`### ${item.title}${speaker}`, "", item.statement, "", `- 类型：${item.type}`, `- 证据：${evidenceMarkdown(note, item.segmentIds, segmentMap) || "无"}`, item.needsExternalVerification ? "- 状态：需外部核验" : "- 状态：仅根据视频内部证据", "");
    }
    lines.push("## 文字大纲", "", synthesis.outline?.summary || "", "", ...outlineMarkdown(synthesis.outline?.items, note, segmentMap), "## 思维导图", "", "```mermaid", "mindmap", ...mermaidMindmapLines(synthesis.mindmap), "```", "");
    const sections = [
      ["案例与证据", synthesis.cases, "summary", "-"],
      ["可执行行动", synthesis.actions, "detail", "- [ ]"],
      ["争议、例外与待核验点", synthesis.controversies, "detail", "-"]
    ];
    for (const [title, items, detailField, prefix] of sections) {
      lines.push(`## ${title}`, "");
      if (!(items || []).length) lines.push("暂无。", "");
      for (const item of items || []) lines.push(`${prefix} **${item.title}**：${item[detailField]} ${evidenceMarkdown(note, item.segmentIds, segmentMap)}`, "");
    }
    lines.push("## 候选原子知识卡片", "", "> 这些是可继续拆分、链接和生长的候选笔记，不会自动改动你的其他 Obsidian 文件。", "");
    for (const card of synthesis.knowledgeCards || []) lines.push(`### [[${safeString(card.title).replace(/[\[\]]/g, "")}]]`, "", card.summary, "", card.concepts?.length ? `- 概念：${card.concepts.map((concept) => `#${concept.replace(/\s+/g, "-")}`).join(" ")}` : "", `- 证据：${evidenceMarkdown(note, card.segmentIds, segmentMap)}`, "");
  } else if (note.knowledge?.audit?.status === "BLOCKED") {
    lines.push("## Codex 阻止原因", "", ...(note.knowledge.audit.issues || []).map((issue) => `- **${issue.code}**：${issue.message}`), "");
  }
  if (!ready) {
    lines.push("## 现有 AI 结构（未经知识流程核查）", "", "> 以下内容仅保留旧版生成结果，不代表 Codex 审计 PASS。", "", "### 文字大纲", "", "```json", note.outline?.tree ? JSON.stringify(note.outline.tree, null, 2) : "暂无大纲。", "```", "", "### 思维导图", "", "```json", note.mindmap?.tree ? JSON.stringify(note.mindmap.tree, null, 2) : "暂无思维导图。", "```", "");
    const original = flattenSegments(firstAvailableTrack(note));
    const polished = note.transcript?.polished?.segments || [];
    const speakerVariant = Object.values(note.transcript?.speaker?.variants || {})[0];
    const speakerSegments = (speakerVariant?.segments || []).map((segment) => ({
      ...segment,
      text: `${note.speaker?.labels?.[segment.speakerId] || segment.speakerId || "未确定"}：${segment.text}`
    }));
    lines.push(segmentsToMarkdown(note, "原文逐字稿（现有版本）", original), segmentsToMarkdown(note, "AI 润色版（现有版本）", polished), segmentsToMarkdown(note, "说话人版（现有版本）", speakerSegments));
  }
  const record = note.record?.html ? htmlToMarkdown(note.record.html) : safeString(note.record?.plainText);
  lines.push("## 我的记录", "", record || "暂无记录。", "", "## 可溯源字幕", "", ...transcriptDetailsMarkdown(note, snapshot), "");
  return lines.filter((line) => line !== undefined && line !== null).join("\n");
}

function validateVaultPath(vaultPath) {
  const resolved = path.resolve(vaultPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new AppError("OBSIDIAN_VAULT_INVALID", "Obsidian Vault 路径不存在或不是文件夹。", {}, 400);
  }
  return resolved;
}

function safeRelativeFolder(folder) {
  const value = safeString(folder || DEFAULT_SETTINGS.obsidianFolder);
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    throw new AppError("INVALID_EXPORT_FOLDER", "导出文件夹只能是 Vault 内的相对路径。", {}, 400);
  }
  return value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "") || DEFAULT_SETTINGS.obsidianFolder;
}

function obsidianPathFor(note, settings) {
  const vault = validateVaultPath(settings.obsidianVaultPath);
  const folder = safeRelativeFolder(settings.obsidianFolder);
  const directory = path.resolve(vault, folder);
  if (!directory.startsWith(`${vault}${path.sep}`) && directory !== vault) {
    throw new AppError("INVALID_EXPORT_FOLDER", "导出目录超出了 Obsidian Vault。", {}, 400);
  }
  fs.mkdirSync(directory, { recursive: true });
  const identifier = sourceId(note) || note.id;
  return path.join(directory, `${safeSlug(note.title, identifier)}-${identifier}.md`);
}

function loadTask(taskId) {
  const task = readJsonFile(taskPath(taskId), null);
  if (!task) throw new AppError("TASK_NOT_FOUND", "任务不存在。", {}, 404);
  return task;
}

function saveTask(task) {
  task.updatedAt = now();
  writeJsonAtomic(taskPath(task.id), task);
  return task;
}

function createTask(type, noteId, meta = {}) {
  const task = {
    id: id("task"),
    type,
    noteId: noteId || "",
    status: "queued",
    progress: 0,
    message: "排队中",
    createdAt: now(),
    updatedAt: now(),
    result: null,
    error: null,
    meta,
    metrics: {
      chunkCount: Number(meta.chunkCount || 0),
      completedChunkCount: 0,
      failedChunkCount: 0,
      inputChars: Number(meta.inputChars || 0),
      outputChars: 0,
      inputTokens: Number(meta.inputTokens || 0),
      outputTokens: 0,
      failedChunkIds: [],
      elapsedMs: 0
    }
  };
  const saved = saveTask(task);
  if (type === "analysis") appendGenerationEvent(saved, "submitted");
  if (type === "analysis") appendOperationEvent(noteId, "ai_task_submitted", {
    taskId: saved.id,
    operation: meta.operation,
    scope: { pageScope: meta.pageScope, trackScope: meta.trackScope },
    chunkCount: meta.chunkCount,
    inputChars: meta.inputChars,
    model: meta.model,
    engine: meta.engine,
    provider: meta.provider
  });
  return saved;
}

async function runTask(task, worker) {
  task.status = "running";
  task.progress = 5;
  task.message = "正在处理";
  task.startedAt = task.startedAt || now();
  task.error = null;
  saveTask(task);
  if (task.type === "analysis") appendGenerationEvent(task, "started");
  if (task.type === "analysis") appendOperationEvent(task.noteId, "ai_task_started", { taskId: task.id, operation: task.meta?.operation });
  if (task.type === "asr") appendOperationEvent(task.noteId, "asr_task_started", { taskId: task.id, pageIndex: task.meta?.pageIndex });
  if (task.type === "diarization") appendOperationEvent(task.noteId, "diarization_task_started", { taskId: task.id, pageIndex: task.meta?.pageIndex, trackId: task.meta?.trackId });
  try {
    let lastLoggedProgress = Number(task.progress || 0);
    let lastLoggedMessage = safeString(task.message);
    let lastLoggedCompletedChunks = Number(task.metrics?.completedChunkCount || 0);
    const result = await worker((progress, message) => {
      task.progress = Math.max(5, Math.min(95, Number(progress) || 5));
      task.message = message || task.message;
      saveTask(task);
      if (task.type === "analysis") {
        const completedChunks = Number(task.metrics?.completedChunkCount || 0);
        const shouldLogProgress = Math.abs(task.progress - lastLoggedProgress) >= 5
          || safeString(task.message) !== lastLoggedMessage
          || completedChunks !== lastLoggedCompletedChunks;
        if (shouldLogProgress) {
          appendGenerationEvent(task, "progress");
          lastLoggedProgress = task.progress;
          lastLoggedMessage = safeString(task.message);
          lastLoggedCompletedChunks = completedChunks;
        }
      }
    });
    task.status = "completed";
    task.progress = 100;
    task.message = "处理完成";
    task.result = result || null;
    task.completedAt = now();
    task.metrics = {
      ...(task.metrics || {}),
      elapsedMs: Math.max(0, Date.parse(task.completedAt) - Date.parse(task.startedAt || task.createdAt))
    };
    saveTask(task);
    if (task.type === "analysis") appendGenerationEvent(task, "completed");
    if (task.type === "analysis") appendOperationEvent(task.noteId, "ai_task_completed", {
      taskId: task.id,
      operation: task.meta?.operation,
      metrics: task.metrics,
      scope: { pageScope: task.meta?.pageScope, trackScope: task.meta?.trackScope },
      result: task.result
    });
    if (task.type === "asr") appendOperationEvent(task.noteId, "asr_task_completed", {
      taskId: task.id,
      pageIndex: task.meta?.pageIndex,
      model: task.meta?.model,
      metrics: task.metrics,
      result: task.result
    });
    if (task.type === "diarization") appendOperationEvent(task.noteId, "diarization_task_completed", {
      taskId: task.id,
      pageIndex: task.meta?.pageIndex,
      trackId: task.meta?.trackId,
      speakerModel: task.meta?.model,
      metrics: task.metrics,
      result: task.result
    });
  } catch (error) {
    task.status = "failed";
    task.progress = 100;
    task.message = "处理失败";
    task.error = {
      code: error.code || "TASK_FAILED",
      message: error.message || "任务失败",
      details: error.details || {}
    };
    task.completedAt = now();
    task.metrics = {
      ...(task.metrics || {}),
      ...(error.details?.metrics || {}),
      elapsedMs: Math.max(0, Date.parse(task.completedAt) - Date.parse(task.startedAt || task.createdAt))
    };
    saveTask(task);
    if (task.type === "analysis") appendGenerationEvent(task, "failed");
    if (task.type === "analysis") appendOperationEvent(task.noteId, "ai_task_failed", {
      taskId: task.id,
      operation: task.meta?.operation,
      code: task.error.code,
      message: task.error.message,
      metrics: task.metrics,
      failedChunkIds: task.metrics?.failedChunkIds || error.details?.failedChunkIds || []
    });
    if (task.type === "analysis" && task.meta?.operation === "knowledge_synthesize") {
      try {
        const note = loadNote(task.noteId);
        note.knowledge.status = "materials_ready";
        note.knowledge.audit = { status: "failed", issues: [{ code: task.error.code, message: task.error.message, chunkIds: [], segmentIds: [] }], checkedAt: now() };
        note.knowledge.synthesis = null;
        saveNote(note);
      } catch {
        // 任务本身的失败记录仍可用。
      }
    }
    if (task.type === "asr") appendOperationEvent(task.noteId, "asr_task_failed", {
      taskId: task.id,
      pageIndex: task.meta?.pageIndex,
      stage: task.meta?.stage,
      code: task.error.code,
      message: task.error.message,
      metrics: task.metrics
    });
    if (task.type === "diarization") appendOperationEvent(task.noteId, "diarization_task_failed", {
      taskId: task.id,
      pageIndex: task.meta?.pageIndex,
      trackId: task.meta?.trackId,
      stage: task.meta?.stage,
      code: task.error.code,
      message: task.error.message,
      metrics: task.metrics
    });
    if (task.type === "asr") {
      try {
        const note = loadNote(task.noteId);
        note.processing = { ...(note.processing || {}), asr: "failed" };
        note.asr = {
          ...(note.asr || {}),
          status: "failed",
          taskId: task.id,
          pageIndex: Number(task.meta?.pageIndex || 0),
          failedStage: safeString(task.meta?.stage || error.details?.stage || "unknown"),
          error: { code: task.error.code, message: redactLogText(task.error.message) },
          failedAt: now()
        };
        saveNote(note);
      } catch (noteError) {
        console.error(`[asr-state] ${noteError.message}`);
      }
    }
    if (task.type === "diarization") {
      try {
        const note = loadNote(task.noteId);
        note.processing = { ...(note.processing || {}), diarization: "failed" };
        note.speaker = {
          ...(note.speaker || {}),
          status: "failed",
          taskId: task.id,
          failedStage: safeString(task.meta?.stage || error.details?.stage || "unknown"),
          error: { code: task.error.code, message: redactLogText(task.error.message) },
          failedAt: now()
        };
        saveNote(note);
      } catch (noteError) {
        console.error(`[diarization-state] ${noteError.message}`);
      }
    }
  }
  return task;
}

function startTask(task, worker) {
  setImmediate(() => {
    runTask(task, worker).catch((error) => {
      task.status = "failed";
      task.error = { code: "TASK_CRASHED", message: error.message };
      saveTask(task);
      if (task.type === "analysis") appendGenerationEvent(task, "crashed");
      else appendOperationEvent(task.noteId, `${task.type}_task_crashed`, { taskId: task.id, message: error.message });
    });
  });
}

function resolveExecutable(configured, candidates = []) {
  const values = [safeString(configured), ...candidates].filter(Boolean);
  for (const value of values) {
    if (path.isAbsolute(value)) {
      try {
        fs.accessSync(value, fs.constants.X_OK);
        return value;
      } catch {
        continue;
      }
    }
    const result = spawnSync("which", [value], { encoding: "utf8", timeout: 4000 });
    const resolved = safeString(result.stdout).split(/\r?\n/)[0];
    if (result.status === 0 && resolved) return resolved;
  }
  return "";
}

function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd || __dirname,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const consume = (streamName, chunk) => {
      const textValue = String(chunk || "");
      if (streamName === "stdout") stdout = `${stdout}${textValue}`.slice(-1024 * 1024);
      else stderr = `${stderr}${textValue}`.slice(-1024 * 1024);
      if (typeof options.onOutput !== "function") return;
      const combined = streamName === "stdout" ? stdout : stderr;
      const lines = combined.split(/\r?\n/);
      const completed = lines.slice(0, -1);
      if (streamName === "stdout") stdout = lines.at(-1) || "";
      else stderr = lines.at(-1) || "";
      for (const line of completed) options.onOutput(streamName, line);
    };
    child.stdout.on("data", (chunk) => consume("stdout", chunk));
    child.stderr.on("data", (chunk) => consume("stderr", chunk));
    child.on("error", (error) => reject(new AppError("PROCESS_START_FAILED", `无法启动 ${path.basename(executable)}：${error.message}`, { executable }, 500)));
    child.on("close", (code, signal) => {
      if (typeof options.onOutput === "function") {
        if (stdout) options.onOutput("stdout", stdout);
        if (stderr) options.onOutput("stderr", stderr);
      }
      if (code === 0) return resolve({ code, signal, stdout, stderr });
      reject(new AppError(options.errorCode || "PROCESS_FAILED", options.errorMessage || `${path.basename(executable)} 执行失败。`, {
        exitCode: code,
        signal,
        output: redactLogText(stderr || stdout, 900)
      }, 500));
    });
  });
}

function cachedModelReady(directory, matcher) {
  try {
    const modelsDirectory = path.join(directory, "models");
    return fs.readdirSync(modelsDirectory).some((name) => {
      if (!matcher.test(name)) return false;
      const snapshot = path.join(modelsDirectory, name, "snapshots", "master");
      const files = fs.readdirSync(snapshot);
      const hasConfig = files.includes("config.yaml") || files.includes("configuration.json");
      const hasWeights = files.some((file) => /\.(?:pt|bin|safetensors)$/i.test(file));
      return hasConfig && hasWeights;
    });
  } catch {
    return false;
  }
}

function modelCacheHasSpeakerModel(directory) {
  return cachedModelReady(directory, /campplus|cam\+\+/i);
}

function modelCacheHasAsrModels(directory) {
  return cachedModelReady(directory, /paraformer/i)
    && cachedModelReady(directory, /fsmn[_-]vad/i)
    && cachedModelReady(directory, /punc/i);
}

function asrRuntimeConfig() {
  const settings = loadSettings();
  const ffmpeg = resolveExecutable(process.env.FFMPEG_BIN, ["ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]);
  const ytdlp = resolveExecutable(process.env.YTDLP_BIN, ["yt-dlp", "/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"]);
  const python = resolveExecutable(process.env.ASR_PYTHON_BIN || settings.asrPythonPath, [path.join(__dirname, ".venv", "bin", "python"), "python3.12", "python3"]);
  return {
    ffmpeg,
    ytdlp,
    python,
    worker: ASR_WORKER_FILE,
    model: safeString(settings.asrModel || DEFAULT_SETTINGS.asrModel),
    vadModel: safeString(settings.asrVadModel || DEFAULT_SETTINGS.asrVadModel),
    puncModel: safeString(settings.asrPuncModel || DEFAULT_SETTINGS.asrPuncModel),
    speakerModel: safeString(settings.speakerModel || DEFAULT_SETTINGS.speakerModel),
    device: ["cpu", "mps"].includes(settings.asrDevice) ? settings.asrDevice : "cpu",
    modelDir: path.resolve(settings.asrModelDir || MODEL_CACHE_DIR),
    cpuThreads: Math.max(1, Math.min(16, Number(settings.asrCpuThreads) || DEFAULT_SETTINGS.asrCpuThreads)),
    speakerMergeGapSeconds: Number(settings.speakerMergeGapSeconds || DEFAULT_SETTINGS.speakerMergeGapSeconds),
    speakerMaxSegmentSeconds: Number(settings.speakerMaxSegmentSeconds || DEFAULT_SETTINGS.speakerMaxSegmentSeconds),
    speakerMinOverlapRatio: Number(settings.speakerMinOverlapRatio || DEFAULT_SETTINGS.speakerMinOverlapRatio),
    speakerLowConfidence: Number(settings.speakerLowConfidence || DEFAULT_SETTINGS.speakerLowConfidence),
    speakerAmbiguityRatio: Number(settings.speakerAmbiguityRatio || DEFAULT_SETTINGS.speakerAmbiguityRatio)
  };
}

function parseLastJsonLine(value) {
  const lines = safeString(value).split(/\r?\n/).filter(Boolean).reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch { /* try previous line */ }
  }
  return null;
}

function getAsrDiagnostics() {
  const config = asrRuntimeConfig();
  let python = null;
  if (config.python && fs.existsSync(config.worker)) {
    const result = spawnSync(config.python, [config.worker, "--diagnose"], { encoding: "utf8", timeout: 20000 });
    python = parseLastJsonLine(result.stdout) || {
      type: "diagnostics",
      ok: false,
      error: redactLogText(result.stderr || `诊断进程退出码 ${result.status}`)
    };
  }
  let availableBytes = null;
  try {
    const stats = fs.statfsSync(DATA_DIR);
    availableBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    // Older Node versions may not expose statfsSync; diagnostics remains useful without it.
  }
  const missing = [];
  if (!config.ffmpeg) missing.push("ffmpeg");
  if (!config.ytdlp) missing.push("yt-dlp");
  if (!config.python) missing.push("python");
  if (!fs.existsSync(config.worker)) missing.push("funasr-worker");
  if (python && !python.ok) missing.push("funasr-runtime");
  return {
    ready: missing.length === 0,
    missing,
    ffmpeg: config.ffmpeg || "",
    ytdlp: config.ytdlp || "",
    python: config.python || "",
    worker: config.worker,
    runtime: python,
    model: config.model,
    vadModel: config.vadModel,
    puncModel: config.puncModel,
    speakerModel: config.speakerModel,
    device: config.device,
    modelDir: config.modelDir,
    firstModelDownload: !modelCacheHasAsrModels(config.modelDir),
    firstSpeakerModelDownload: !modelCacheHasSpeakerModel(config.modelDir),
    availableBytes,
    hints: {
      firstDownload: "首次运行会下载 Paraformer、FSMN-VAD 和 CT-Punc 模型，请预留数 GB 磁盘和稳定网络。",
      firstSpeakerDownload: "首次说话人识别还会下载 CAM++ 模型；只在你主动启动说话人识别后发生。",
      performance: "默认使用 CPU，不承诺固定倍速；任务完成后会记录音频时长和实际耗时。",
      install: "运行 npm run setup:asr 可创建项目虚拟环境并安装 FunASR 依赖。"
    }
  };
}

function assertAsrReady(config, diagnostics = getAsrDiagnostics()) {
  if (diagnostics.ready) return;
  const messages = {
    ffmpeg: "没有找到 FFmpeg，无法把音频转换为 16kHz 单声道 WAV。",
    "yt-dlp": "没有找到 yt-dlp，无法从在线视频获取媒体。",
    python: "没有找到可用的 ASR Python 环境。",
    "funasr-worker": "FunASR worker 文件不存在。",
    "funasr-runtime": "Python 环境缺少 FunASR 或 PyTorch。"
  };
  const first = diagnostics.missing[0] || "funasr-runtime";
  throw new AppError("ASR_DEPENDENCY_MISSING", messages[first] || "本地 ASR 依赖不完整。", {
    missing: diagnostics.missing,
    installHint: diagnostics.hints.install,
    python: config.python
  }, 503);
}

function safeAsrTempPath(taskId) {
  if (!/^task_[a-z0-9]+$/i.test(taskId)) throw new AppError("INVALID_TASK_ID", "ASR 任务编号不正确。", {}, 400);
  return path.join(ASR_TEMP_DIR, taskId);
}

function createAsrTask(note, body = {}) {
  const pageIndex = Math.max(0, Math.min((note.source?.pages || []).length - 1, Number(body.pageIndex) || 0));
  const page = note.source?.pages?.[pageIndex];
  if (!page) throw new AppError("ASR_PAGE_NOT_FOUND", "这条笔记没有可处理的分 P 信息。", { pageIndex }, 422);
  const config = asrRuntimeConfig();
  const task = createTask("asr", note.id, {
    operation: "asr",
    pageIndex,
    page: page.page,
    cid: page.cid,
    duration: Number(page.duration || note.source?.duration || 0),
    model: config.model,
    vadModel: config.vadModel,
    puncModel: config.puncModel,
    device: config.device,
    stage: "queued"
  });
  task.asr = {
    request: { pageIndex },
    sourceUrl: safeString(note.source?.url),
    page: clone(page)
  };
  saveTask(task);
  appendOperationEvent(note.id, "asr_task_submitted", {
    taskId: task.id,
    pageIndex,
    model: config.model,
    vadModel: config.vadModel,
    puncModel: config.puncModel,
    device: config.device,
    loginUsed: Boolean(body.sessdata || body.browserCookies),
    loginSource: body.browserCookies ? "browser" : body.sessdata ? "sessdata" : "none"
  });
  return { task, config, credentials: normalizeSourceCredentials(body) };
}

function activeTaskFor(noteId, type) {
  return fs.readdirSync(TASKS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJsonFile(path.join(TASKS_DIR, name), null))
    .find((task) => task?.noteId === noteId && task.type === type && ["queued", "running"].includes(task.status));
}

function asrTrackId(pageNumber) {
  return `local-funasr-p${Number(pageNumber) || 1}`;
}

function saveAsrTranscript(note, task, payload, audioPath) {
  const pageIndex = Number(task.meta?.pageIndex || 0);
  const pageMeta = note.source?.pages?.[pageIndex];
  if (!pageMeta) throw new AppError("ASR_PAGE_NOT_FOUND", "保存 ASR 结果时找不到对应分 P。", { pageIndex }, 422);
  note.transcript = note.transcript || {};
  const original = note.transcript.original || { source: "pending", status: "missing", pages: [] };
  const pages = Array.isArray(original.pages) ? clone(original.pages) : [];
  while (pages.length <= pageIndex) {
    const sourcePage = note.source.pages[pages.length] || {};
    pages.push({ page: sourcePage.page || pages.length + 1, cid: sourcePage.cid || 0, part: sourcePage.part || `P${pages.length + 1}`, duration: sourcePage.duration || 0, subtitles: [] });
  }
  const page = pages[pageIndex];
  page.page = pageMeta.page;
  page.cid = pageMeta.cid;
  page.part = pageMeta.part;
  page.duration = pageMeta.duration;
  page.subtitles = Array.isArray(page.subtitles) ? page.subtitles : [];
  const trackId = asrTrackId(pageMeta.page);
  const resolvedAudioPath = path.resolve(audioPath);
  const storedAudioPath = resolvedAudioPath.startsWith(`${DATA_DIR}${path.sep}`)
    ? path.relative(DATA_DIR, resolvedAudioPath).replaceAll(path.sep, "/")
    : safeString(audioPath);
  const body = payload.segments.map((segment, index) => ({
    id: safeString(segment.id) || `${trackId}-seg-${index + 1}`,
    index,
    from: Number(segment.from || 0),
    to: Number(segment.to || 0),
    text: safeString(segment.text),
    content: safeString(segment.text)
  })).filter((segment) => segment.text && segment.to > segment.from);
  if (!body.length) throw new AppError("ASR_EMPTY_RESULT", "FunASR 没有生成可保存的时间轴文字。", {}, 502);
  const track = {
    id: trackId,
    language: "zh-CN",
    languageName: "中文",
    label: "本地 ASR",
    source: "funasr",
    isAI: false,
    body,
    segments: body.map(({ content, ...segment }) => segment),
    generatedAt: now(),
    model: payload.model || task.meta.model,
    vadModel: payload.vadModel || task.meta.vadModel,
    puncModel: payload.puncModel || task.meta.puncModel,
    device: payload.device || task.meta.device,
    taskId: task.id,
    audioPath: storedAudioPath
  };
  page.subtitles = [...page.subtitles.filter((item) => item.id !== trackId), track];
  original.pages = pages;
  original.status = "ready";
  const previousSource = safeString(original.source);
  original.source = previousSource === "bilibili" || previousSource === "mixed" || page.subtitles.some((item) => item.source !== "funasr") ? "mixed" : "funasr";
  original.sources = [...new Set([...(original.sources || []), ...(previousSource === "bilibili" || previousSource === "mixed" ? ["bilibili"] : []), track.source])];
  original.generatedAt = now();
  note.transcript.original = original;
  note.processing = { ...(note.processing || {}), asr: "ready" };
  note.status = "ready";
  note.asr = {
    status: "ready",
    pageIndex,
    trackId,
    taskId: task.id,
    audioPath: storedAudioPath,
    segmentCount: body.length,
    model: track.model,
    vadModel: track.vadModel,
    puncModel: track.puncModel,
    device: track.device,
    elapsedMs: payload.elapsedMs,
    generatedAt: track.generatedAt
  };
  invalidateKnowledge(note, "本地 ASR 字幕轨道已更新");
  return saveNote(note);
}

function sourceTrackFor(note, pageIndex, trackIndex) {
  const page = note.transcript?.original?.pages?.[pageIndex];
  const track = page?.subtitles?.[trackIndex];
  if (!page || !track || !flattenSegments(track).length) {
    throw new AppError("DIARIZATION_TRANSCRIPT_MISSING", "当前 P 和字幕轨道没有可用于生成说话人版的文字。", { pageIndex, trackIndex }, 422);
  }
  return { page, track };
}

function createDiarizationTask(note, body = {}) {
  const pageIndex = Math.max(0, Math.min((note.source?.pages || []).length - 1, Number(body.pageIndex) || 0));
  const trackIndex = Math.max(0, Number(body.trackIndex) || 0);
  const { page, track } = sourceTrackFor(note, pageIndex, trackIndex);
  const config = asrRuntimeConfig();
  const sourceKey = analysisSourceKey(page, track);
  const task = createTask("diarization", note.id, {
    operation: "diarization",
    pageIndex,
    trackIndex,
    page: Number(page.page || pageIndex + 1),
    trackId: safeString(track.id),
    sourceKey,
    duration: Number(page.duration || note.source?.duration || 0),
    model: config.speakerModel,
    vadModel: config.vadModel,
    device: config.device,
    stage: "queued"
  });
  task.diarization = {
    request: { pageIndex, trackIndex, sourceKey },
    sourceUrl: safeString(note.source?.url),
    page: clone(note.source?.pages?.[pageIndex] || page)
  };
  saveTask(task);
  appendOperationEvent(note.id, "diarization_task_submitted", {
    taskId: task.id,
    pageIndex,
    trackId: track.id,
    sourceKey,
    speakerModel: config.speakerModel,
    loginUsed: Boolean(body.sessdata || body.browserCookies),
    loginSource: body.browserCookies ? "browser" : body.sessdata ? "sessdata" : "none"
  });
  return { task, config, credentials: normalizeSourceCredentials(body) };
}

function overlapDuration(left, right) {
  return Math.max(0, Math.min(Number(left.to), Number(right.to)) - Math.max(Number(left.from), Number(right.from)));
}

function preferredSpeakerTextSegments(note, pageIndex, trackIndex) {
  const { page, track } = sourceTrackFor(note, pageIndex, trackIndex);
  const originals = flattenSegments(track);
  const sourceKey = analysisSourceKey(page, track);
  const polished = note.transcript?.polished?.variants?.[sourceKey];
  const polishedSegments = Array.isArray(polished?.segments) ? polished.segments : [];
  const polishedById = new Map(polishedSegments.map((segment) => [safeString(segment.segmentId || segment.id), safeString(segment.text)]));
  const completePolished = originals.length > 0 && originals.every((segment) => polishedById.has(segment.id) && polishedById.get(segment.id));
  return {
    sourceKey,
    source: completePolished ? "polished" : "original",
    segments: originals.map((segment) => ({
      ...segment,
      text: completePolished ? polishedById.get(segment.id) : segment.text,
      sourceSegmentIds: [segment.id]
    }))
  };
}

function mapTranscriptToSpeakers(textSegments, speakerIntervals, options = {}) {
  const minOverlapRatio = Number(options.minOverlapRatio ?? DEFAULT_SETTINGS.speakerMinOverlapRatio);
  const lowConfidence = Number(options.lowConfidence ?? DEFAULT_SETTINGS.speakerLowConfidence);
  const ambiguityRatio = Number(options.ambiguityRatio ?? DEFAULT_SETTINGS.speakerAmbiguityRatio);
  return (textSegments || []).map((segment) => {
    const duration = Math.max(0.05, Number(segment.to) - Number(segment.from));
    const overlaps = new Map();
    const confidences = new Map();
    for (const interval of speakerIntervals || []) {
      const overlap = overlapDuration(segment, interval);
      if (overlap <= 0) continue;
      const speakerId = safeString(interval.speakerId) || "speaker_unknown";
      overlaps.set(speakerId, Number(overlaps.get(speakerId) || 0) + overlap);
      if (interval.confidence !== null && interval.confidence !== undefined && interval.confidence !== "" && Number.isFinite(Number(interval.confidence))) {
        const values = confidences.get(speakerId) || [];
        values.push({ value: Number(interval.confidence), weight: overlap });
        confidences.set(speakerId, values);
      }
    }
    const ranked = [...overlaps.entries()].sort((a, b) => b[1] - a[1]);
    const best = ranked[0] || ["speaker_unknown", 0];
    const second = ranked[1] || ["", 0];
    const overlapRatio = best[1] / duration;
    const confidenceValues = confidences.get(best[0]) || [];
    const modelConfidence = confidenceValues.length
      ? confidenceValues.reduce((sum, item) => sum + item.value * item.weight, 0) / confidenceValues.reduce((sum, item) => sum + item.weight, 0)
      : null;
    let speakerId = best[0];
    let assignment = "matched";
    if (!ranked.length || overlapRatio < minOverlapRatio || (modelConfidence !== null && modelConfidence < lowConfidence)) {
      speakerId = "speaker_unknown";
      assignment = "low_confidence";
    } else if (second[1] > 0 && second[1] / best[1] >= ambiguityRatio) {
      speakerId = "speaker_multiple";
      assignment = "multiple";
    }
    return {
      ...segment,
      speakerId,
      confidence: Number(Math.min(1, modelConfidence === null ? overlapRatio : modelConfidence * overlapRatio).toFixed(4)),
      assignment,
      sourceSegmentIds: [...new Set(segment.sourceSegmentIds || [segment.id])]
    };
  });
}

function cleanSpeakerJoin(parts) {
  return parts.map((value) => safeString(value)).filter(Boolean).join(" ")
    .replace(/\s+([，。！？、；：,.!?;:])/g, "$1")
    .replace(/([（(])\s+/g, "$1")
    .replace(/\s+([）)])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function polishedSentenceCount(text) {
  return (safeString(text).match(/[。！？!?]+/g) || []).length;
}

function mergePolishedParagraphSegments(segments, options = {}) {
  const maxChars = Number(options.maxChars || POLISHED_PARAGRAPH_MAX_CHARS);
  const maxSeconds = Number(options.maxSeconds || POLISHED_PARAGRAPH_MAX_SECONDS);
  const maxSentences = Number(options.maxSentences || POLISHED_PARAGRAPH_MAX_SENTENCES);
  const maxGapSeconds = Number(options.maxGapSeconds || POLISHED_PARAGRAPH_MAX_GAP_SECONDS);
  const output = [];
  for (const rawSegment of segments || []) {
    const segment = normalizeAnalysisSegment(rawSegment, output.length);
    const sourceSegmentIds = [...new Set((rawSegment.sourceSegmentIds || [segment.segmentId]).map(safeString).filter(Boolean))];
    const originalText = safeString(rawSegment.originalText || rawSegment.text);
    const previous = output[output.length - 1];
    const combinedText = previous ? cleanSpeakerJoin([previous.text, segment.text]) : segment.text;
    const canMerge = previous
      && previous.paragraphBreak !== true
      && previous.sourceKey === segment.sourceKey
      && Number(segment.from) - Number(previous.to) <= maxGapSeconds
      && Number(segment.to) - Number(previous.from) <= maxSeconds
      && combinedText.length <= maxChars
      && polishedSentenceCount(previous.text) < maxSentences;
    if (canMerge) {
      previous.to = Number(segment.to);
      previous.text = combinedText;
      previous.content = combinedText;
      previous.originalText = cleanSpeakerJoin([previous.originalText, originalText]);
      previous.sourceSegmentIds = [...new Set([...previous.sourceSegmentIds, ...sourceSegmentIds])];
      previous.paragraphBreak = Boolean(segment.paragraphBreak);
      continue;
    }
    output.push({
      ...segment,
      id: "",
      segmentId: "",
      text: segment.text,
      content: segment.text,
      originalText,
      sourceSegmentIds,
      paragraphBreak: Boolean(segment.paragraphBreak)
    });
  }
  return output.map((paragraph, index) => {
    const stable = crypto.createHash("sha1").update(`${paragraph.sourceKey}|${paragraph.sourceSegmentIds.join("|")}`).digest("hex").slice(0, 12);
    const paragraphId = `paragraph-${stable || String(index + 1).padStart(6, "0")}`;
    return { ...paragraph, id: paragraphId, segmentId: paragraphId };
  });
}

function mergeSpeakerTranscriptSegments(mappedSegments, options = {}) {
  const gapSeconds = Number(options.gapSeconds ?? DEFAULT_SETTINGS.speakerMergeGapSeconds);
  const maxSegmentSeconds = Number(options.maxSegmentSeconds ?? DEFAULT_SETTINGS.speakerMaxSegmentSeconds);
  const output = [];
  for (const segment of mappedSegments || []) {
    if (!safeString(segment.text) || !(Number(segment.to) > Number(segment.from))) continue;
    const previous = output[output.length - 1];
    const mergeableSpeaker = !["speaker_unknown", "speaker_multiple"].includes(segment.speakerId);
    const canMerge = previous
      && mergeableSpeaker
      && previous.speakerId === segment.speakerId
      && Number(segment.from) - Number(previous.to) <= gapSeconds
      && Number(segment.to) - Number(previous.from) <= maxSegmentSeconds;
    if (canMerge) {
      previous.to = Number(segment.to);
      previous.text = cleanSpeakerJoin([previous.text, segment.text]);
      previous.sourceSegmentIds = [...new Set([...previous.sourceSegmentIds, ...(segment.sourceSegmentIds || [segment.id])])];
      previous.confidence = Number(((previous.confidence * previous._sourceCount + Number(segment.confidence || 0)) / (previous._sourceCount + 1)).toFixed(4));
      previous._sourceCount += 1;
      continue;
    }
    output.push({
      id: "",
      speakerId: safeString(segment.speakerId) || "speaker_unknown",
      from: Number(segment.from),
      to: Number(segment.to),
      text: safeString(segment.text),
      sourceSegmentIds: [...new Set(segment.sourceSegmentIds || [segment.id])],
      confidence: Number(segment.confidence || 0),
      assignment: safeString(segment.assignment),
      _sourceCount: 1
    });
  }
  return output.map((segment, index) => {
    const stable = crypto.createHash("sha1").update(`${segment.speakerId}|${segment.sourceSegmentIds.join("|")}`).digest("hex").slice(0, 12);
    const { _sourceCount, ...publicSegment } = segment;
    return { ...publicSegment, id: `speaker-seg-${stable || String(index + 1).padStart(6, "0")}` };
  });
}

function buildSpeakerTranscript(note, pageIndex, trackIndex, speakerIntervals, options = {}) {
  const preferred = preferredSpeakerTextSegments(note, pageIndex, trackIndex);
  const mapped = mapTranscriptToSpeakers(preferred.segments, speakerIntervals, options);
  return { ...preferred, segments: mergeSpeakerTranscriptSegments(mapped, options) };
}

function saveDiarizationResult(note, task, payload) {
  const pageIndex = Number(task.meta?.pageIndex || 0);
  const trackIndex = Number(task.meta?.trackIndex || 0);
  const config = asrRuntimeConfig();
  const intervals = (payload.speakerSegments || []).map((segment) => ({
    speakerId: safeString(segment.speakerId),
    from: Number(segment.from),
    to: Number(segment.to),
    confidence: segment.confidence !== null && segment.confidence !== undefined && segment.confidence !== "" && Number.isFinite(Number(segment.confidence)) ? Number(segment.confidence) : null
  })).filter((segment) => segment.speakerId && segment.to > segment.from);
  if (!intervals.length) throw new AppError("DIARIZATION_EMPTY_RESULT", "CAM++ 没有生成可保存的说话人区间。", {}, 502);
  const built = buildSpeakerTranscript(note, pageIndex, trackIndex, intervals, {
    gapSeconds: config.speakerMergeGapSeconds,
    maxSegmentSeconds: config.speakerMaxSegmentSeconds,
    minOverlapRatio: config.speakerMinOverlapRatio,
    lowConfidence: config.speakerLowConfidence,
    ambiguityRatio: config.speakerAmbiguityRatio
  });
  if (!built.segments.length) throw new AppError("DIARIZATION_ALIGNMENT_EMPTY", "说话人区间无法和当前字幕时间轴对齐。", {}, 422);
  const existingLabels = note.speaker?.labels || {};
  const speakerIds = [...new Set(intervals.map((segment) => segment.speakerId))];
  const labels = { ...existingLabels, speaker_unknown: existingLabels.speaker_unknown || "未确定", speaker_multiple: existingLabels.speaker_multiple || "多人" };
  speakerIds.forEach((speakerId, index) => { labels[speakerId] ||= `说话人 ${index + 1}`; });
  note.speaker = {
    ...(note.speaker || {}),
    status: "ready",
    model: payload.speakerModel || task.meta.model,
    pageIndex,
    taskId: task.id,
    segments: intervals,
    variants: {
      ...(note.speaker?.variants || {}),
      [built.sourceKey]: {
        sourceKey: built.sourceKey,
        pageIndex,
        trackIndex,
        trackId: task.meta.trackId,
        taskId: task.id,
        segments: intervals,
        generatedAt: now()
      }
    },
    labels,
    generatedAt: now()
  };
  note.transcript = note.transcript || {};
  const speakerTranscript = note.transcript.speaker || { status: "not_generated", variants: {} };
  speakerTranscript.status = "ready";
  speakerTranscript.source = built.source;
  speakerTranscript.variants = { ...(speakerTranscript.variants || {}), [built.sourceKey]: {
    sourceKey: built.sourceKey,
    source: built.source,
    pageIndex,
    trackIndex,
    trackId: task.meta.trackId,
    taskId: task.id,
    segments: built.segments,
    generatedAt: now(),
    rules: {
      mergeGapSeconds: config.speakerMergeGapSeconds,
      maxSegmentSeconds: config.speakerMaxSegmentSeconds,
      minOverlapRatio: config.speakerMinOverlapRatio,
      lowConfidence: config.speakerLowConfidence,
      ambiguityRatio: config.speakerAmbiguityRatio
    }
  }};
  speakerTranscript.generatedAt = now();
  note.transcript.speaker = speakerTranscript;
  note.processing = { ...(note.processing || {}), diarization: "ready" };
  invalidateKnowledge(note, "说话人归属已更新");
  return saveNote(note);
}

function mediaCacheStem(note, pageNumber = 1) {
  return `${safeSlug(sourceId(note) || note.id, note.id).replace(/\s+/g, "-")}-p${Number(pageNumber) || 1}`;
}

function storedDataPath(filePath) {
  const resolved = path.resolve(filePath);
  return resolved.startsWith(`${DATA_DIR}${path.sep}`)
    ? path.relative(DATA_DIR, resolved).replaceAll(path.sep, "/")
    : safeString(filePath);
}

function resolveStoredMediaPath(storedPath, allowedRoot) {
  const value = safeString(storedPath);
  if (!value) return "";
  const resolved = path.resolve(DATA_DIR, value);
  if (!resolved.startsWith(`${allowedRoot}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return "";
  return resolved;
}

function resolveCachedMedia(note) {
  return resolveStoredMediaPath(note.media?.videoPath || note.media?.localPath, VIDEO_CACHE_DIR);
}

function resolveCachedAudio(note, pageNumber) {
  const candidate = safeString(note.asr?.audioPath);
  if (candidate) {
    const resolved = path.resolve(DATA_DIR, candidate);
    if (resolved.startsWith(`${AUDIO_CACHE_DIR}${path.sep}`) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  }
  const expected = path.join(AUDIO_CACHE_DIR, note.id, `${mediaCacheStem(note, pageNumber)}-16k.wav`);
  return fs.existsSync(expected) && fs.statSync(expected).isFile() ? expected : "";
}

function downloaderCredentialArgs(note, credentialInput, cookieFile) {
  const credentials = normalizeSourceCredentials(credentialInput);
  if (sourceProvider(note) === "douyin") {
    return credentials.browserCookies ? ["--cookies-from-browser", credentials.browserCookies] : [];
  }
  if (!credentials.sessdata) return [];
  if (/[\r\n;]/.test(credentials.sessdata)) throw new AppError("INVALID_SESSION", "SESSDATA 格式不正确，请只粘贴 Cookie 的值。", {}, 400);
  fs.writeFileSync(cookieFile, `# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\t${credentials.sessdata}\n`, { encoding: "utf8", mode: 0o600 });
  return ["--cookies", cookieFile];
}

function cacheDownloadedVideo(note, sourceFile, pageNumber = 1) {
  const extension = [".mp4", ".mov", ".m4v", ".webm"].includes(path.extname(sourceFile).toLowerCase())
    ? path.extname(sourceFile).toLowerCase()
    : ".mp4";
  const directory = path.join(VIDEO_CACHE_DIR, note.id);
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${mediaCacheStem(note, pageNumber)}${extension}`);
  fs.copyFileSync(sourceFile, target);
  note.media = {
    ...(note.media || {}),
    status: "ready",
    videoPath: storedDataPath(target),
    mimeType: mimeType(target),
    bytes: fs.statSync(target).size,
    updatedAt: now()
  };
  return target;
}

async function prepareDiarizationAudio(note, task, credentialInput, config, tempDirectory, reportProgress) {
  const pageNumber = Number(task.meta?.page || 1);
  const cached = resolveCachedAudio(note, pageNumber);
  if (cached) {
    reportProgress(18, "已找到本机 ASR 音频缓存，不重复下载");
    return cached;
  }
  const cachedMedia = resolveCachedMedia(note);
  const sourceUrl = new URL(task.diarization?.sourceUrl || note.source.url);
  if (sourceProvider(note) === "bilibili") sourceUrl.searchParams.set("p", String(pageNumber));
  const rawTemplate = path.join(tempDirectory, "source.%(ext)s");
  const cookieFile = path.join(tempDirectory, "cookies.txt");
  const audioDirectory = path.join(AUDIO_CACHE_DIR, note.id);
  fs.mkdirSync(audioDirectory, { recursive: true });
  const audioPath = path.join(audioDirectory, `${mediaCacheStem(note, pageNumber)}-16k.wav`);
  if (cachedMedia) {
    task.meta.stage = "preprocess";
    reportProgress(18, "正在从本地媒体缓存提取说话人识别音频");
    await runProcess(config.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", cachedMedia, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath], {
      errorCode: "DIARIZATION_PREPROCESS_FAILED",
      errorMessage: "本地媒体音频预处理失败；已有字幕没有被修改。"
    });
    return audioPath;
  }
  task.meta.stage = "download";
  reportProgress(8, "正在只下载说话人识别所需的音频流");
  const downloadArgs = ["--no-config", "--no-playlist", "--newline", "--no-warnings", "-f", "bestaudio/best", "-o", rawTemplate];
  downloadArgs.push(...downloaderCredentialArgs(note, credentialInput, cookieFile));
  downloadArgs.push(sourceUrl.toString());
  await runProcess(config.ytdlp, downloadArgs, { cwd: tempDirectory, errorCode: "DIARIZATION_DOWNLOAD_FAILED", errorMessage: "说话人识别所需音频下载失败；已有字幕没有被修改。" });
  const rawAudio = fs.readdirSync(tempDirectory).map((name) => path.join(tempDirectory, name))
    .find((file) => file !== cookieFile && fs.statSync(file).isFile() && !file.endsWith(".part"));
  if (!rawAudio) throw new AppError("DIARIZATION_AUDIO_NOT_FOUND", "下载完成后没有找到音频文件。", {}, 502);
  task.meta.stage = "preprocess";
  reportProgress(28, "正在转换为 16kHz 单声道 WAV");
  await runProcess(config.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", rawAudio, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath], {
    errorCode: "DIARIZATION_PREPROCESS_FAILED",
    errorMessage: "FFmpeg 音频预处理失败；已有字幕没有被修改。"
  });
  return audioPath;
}

async function executeDiarizationTask(task, credentialInput, reportProgress) {
  const note = loadNote(task.noteId);
  const config = asrRuntimeConfig();
  assertAsrReady(config);
  const tempDirectory = safeAsrTempPath(task.id);
  fs.mkdirSync(tempDirectory, { recursive: true });
  const outputFile = path.join(tempDirectory, "diarization-result.json");
  try {
    const audioPath = await prepareDiarizationAudio(note, task, credentialInput, config, tempDirectory, reportProgress);
    task.meta.stage = "model_loading";
    reportProgress(45, "正在加载 CAM++ 说话人模型；首次运行会下载模型");
    let workerError = null;
    await runProcess(config.python, [config.worker, "--input", audioPath, "--output", outputFile, "--model", config.model, "--vad-model", config.vadModel, "--punc-model", config.puncModel, "--diarize", "--speaker-model", config.speakerModel, "--device", config.device, "--model-cache-dir", config.modelDir, "--cpu-threads", String(config.cpuThreads)], {
      errorCode: "DIARIZATION_FAILED",
      errorMessage: "本地说话人识别失败；原文和 AI 润色版没有被修改。",
      env: { MODELSCOPE_CACHE: config.modelDir },
      onOutput: (stream, line) => {
        if (stream !== "stdout") return;
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === "progress") {
          task.meta.stage = safeString(event.stage || "diarization");
          reportProgress(Math.max(45, Number(event.progress || 55)), safeString(event.message || "正在识别说话人"));
        }
        if (event.type === "error") workerError = event;
      }
    }).catch((error) => {
      if (workerError) throw new AppError(workerError.code || "DIARIZATION_FAILED", workerError.message || error.message, { stage: workerError.stage || "diarization" }, 500);
      throw error;
    });
    const payload = readJsonFile(outputFile, null);
    if (!payload?.ok || !Array.isArray(payload.speakerSegments)) throw new AppError("DIARIZATION_INVALID_RESULT", "说话人识别结果文件不完整，未写入笔记。", {}, 502);
    task.meta.stage = "align";
    reportProgress(94, "正在按说话人区间确定性拼接已有文字");
    const saved = saveDiarizationResult(note, task, payload);
    const variant = saved.transcript.speaker.variants[task.meta.sourceKey];
    task.metrics = {
      ...(task.metrics || {}),
      audioDurationSeconds: Number(task.meta.duration || 0),
      rawSpeakerSegmentCount: payload.speakerSegments.length,
      speakerCount: Number(payload.speakerCount || 0),
      mergedSegmentCount: variant.segments.length,
      modelElapsedMs: Number(payload.elapsedMs || 0),
      speakerModel: payload.speakerModel || config.speakerModel,
      textSource: variant.source
    };
    task.meta.stage = "completed";
    saveTask(task);
    return { noteId: saved.id, sourceKey: task.meta.sourceKey, speakerCount: task.metrics.speakerCount, segmentCount: variant.segments.length, textSource: variant.source };
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

async function executeAsrTask(task, credentialInput, reportProgress) {
  const note = loadNote(task.noteId);
  const config = asrRuntimeConfig();
  assertAsrReady(config);
  const tempDirectory = safeAsrTempPath(task.id);
  fs.mkdirSync(tempDirectory, { recursive: true });
  const pageNumber = Number(task.asr?.page?.page || task.meta?.page || 1);
  const sourceUrl = new URL(task.asr?.sourceUrl || note.source.url);
  if (sourceProvider(note) === "bilibili") sourceUrl.searchParams.set("p", String(pageNumber));
  const rawTemplate = path.join(tempDirectory, "source.%(ext)s");
  const cookieFile = path.join(tempDirectory, "cookies.txt");
  const outputFile = path.join(tempDirectory, "asr-result.json");
  const audioDirectory = path.join(AUDIO_CACHE_DIR, note.id);
  fs.mkdirSync(audioDirectory, { recursive: true });
  const audioPath = path.join(audioDirectory, `${mediaCacheStem(note, pageNumber)}-16k.wav`);
  try {
    task.meta.stage = "download";
    const provider = sourceProvider(note);
    let rawAudio = resolveCachedMedia(note);
    if (rawAudio) {
      reportProgress(20, "已找到本地媒体缓存，不重复下载");
    } else {
      reportProgress(10, provider === "douyin" ? "正在获取抖音视频用于识别和时间戳播放" : "正在只下载音频流");
      const format = provider === "douyin" ? "bv*[height<=720]+ba/b[height<=720]/b" : "bestaudio/best";
      const downloadArgs = ["--no-config", "--no-playlist", "--newline", "--no-warnings", "-f", format, "-o", rawTemplate];
      if (provider === "douyin") downloadArgs.push("--merge-output-format", "mp4");
      downloadArgs.push(...downloaderCredentialArgs(note, credentialInput, cookieFile));
      downloadArgs.push(sourceUrl.toString());
      const credentials = normalizeSourceCredentials(credentialInput);
      await runProcess(config.ytdlp, downloadArgs, {
        cwd: tempDirectory,
        errorCode: provider === "douyin" && !credentials.browserCookies ? "DOUYIN_COOKIE_REQUIRED" : "ASR_DOWNLOAD_FAILED",
        errorMessage: provider === "douyin" && !credentials.browserCookies
          ? "抖音限制了媒体读取；重试时可授权临时读取浏览器登录态，或拖入本地视频。"
          : "媒体下载失败；笔记和已有字幕没有被修改。",
        onOutput: (_stream, line) => {
          const match = line.match(/(\d+(?:\.\d+)?)%/);
          if (match) reportProgress(10 + Math.round(Math.min(100, Number(match[1])) * 0.22), `正在下载媒体 ${match[1]}%`);
        }
      });
      rawAudio = fs.readdirSync(tempDirectory)
        .map((name) => path.join(tempDirectory, name))
        .find((file) => file !== cookieFile && file !== outputFile && fs.statSync(file).isFile() && !file.endsWith(".part"));
      if (rawAudio && provider === "douyin") {
        rawAudio = cacheDownloadedVideo(note, rawAudio, pageNumber);
        saveNote(note);
      }
    }
    if (!rawAudio) throw new AppError("ASR_AUDIO_NOT_FOUND", "下载完成后没有找到音频文件。", {}, 502);

    task.meta.stage = "preprocess";
    reportProgress(35, "正在转换为 16kHz 单声道 WAV");
    const duration = Math.max(1, Number(task.meta.duration || 1));
    await runProcess(config.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", rawAudio, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-progress", "pipe:1", "-nostats", audioPath], {
      errorCode: "ASR_PREPROCESS_FAILED",
      errorMessage: "FFmpeg 音频预处理失败；笔记和已有字幕没有被修改。",
      onOutput: (stream, line) => {
        if (stream !== "stdout") return;
        const match = line.match(/^out_time_(?:ms|us)=(\d+)/);
        if (match) reportProgress(35 + Math.round(Math.min(1, Number(match[1]) / 1000000 / duration) * 18), "正在转换音频格式");
      }
    });

    task.meta.stage = "model_loading";
    reportProgress(55, "准备本地 FunASR 模型");
    let workerError = null;
    await runProcess(config.python, [config.worker, "--input", audioPath, "--output", outputFile, "--model", config.model, "--vad-model", config.vadModel, "--punc-model", config.puncModel, "--device", config.device, "--model-cache-dir", config.modelDir, "--cpu-threads", String(config.cpuThreads)], {
      errorCode: "FUNASR_FAILED",
      errorMessage: "FunASR 识别失败；笔记和已有字幕没有被修改。",
      env: { MODELSCOPE_CACHE: config.modelDir },
      onOutput: (stream, line) => {
        if (stream !== "stdout") return;
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === "progress") {
          task.meta.stage = safeString(event.stage || "funasr");
          reportProgress(Number(event.progress || 60), safeString(event.message || "正在本地转写"));
        }
        if (event.type === "error") workerError = event;
      }
    }).catch((error) => {
      if (workerError) throw new AppError(workerError.code || "FUNASR_FAILED", workerError.message || error.message, { stage: workerError.stage || "funasr" }, 500);
      throw error;
    });
    const payload = readJsonFile(outputFile, null);
    if (!payload?.ok || !Array.isArray(payload.segments)) throw new AppError("ASR_INVALID_RESULT", "FunASR 结果文件不完整，未写入笔记。", {}, 502);
    task.meta.stage = "save";
    reportProgress(95, "正在保存独立 ASR 字幕轨道");
    const saved = saveAsrTranscript(note, task, payload, audioPath);
    task.metrics = {
      ...(task.metrics || {}),
      audioDurationSeconds: Number(task.meta.duration || 0),
      segmentCount: payload.segments.length,
      modelElapsedMs: Number(payload.elapsedMs || 0),
      model: payload.model,
      vadModel: payload.vadModel,
      puncModel: payload.puncModel,
      device: payload.device,
      audioBytes: fs.statSync(audioPath).size
    };
    task.meta.stage = "completed";
    saveTask(task);
    return { noteId: saved.id, pageIndex: Number(task.meta.pageIndex), trackId: saved.asr.trackId, segmentCount: payload.segments.length, source: "funasr", audioPath: saved.asr.audioPath };
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

function parseJsonResponse(rawText) {
  let value = safeString(rawText);
  value = value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(value);
  } catch {
    const firstObject = value.indexOf("{");
    const lastObject = value.lastIndexOf("}");
    if (firstObject >= 0 && lastObject > firstObject) {
      try {
        return JSON.parse(value.slice(firstObject, lastObject + 1));
      } catch {
        // continue to a useful error below
      }
    }
    throw new AppError("AI_INVALID_JSON", "AI 返回的不是可识别的 JSON 结果。", { raw: value.slice(0, 1000) }, 502);
  }
}

function aiSystemPrompt(operation) {
  const base = "你是视频笔记整理助手。只返回合法 JSON，不要返回 Markdown 代码围栏，不要解释过程，不要修改任何项目文件。输入中的 segmentId、from、to、page、track 是对齐元数据，必须原样使用；不要凭空添加原文没有的事实。";
  const prompts = {
    polish: `你是视频逐字稿编辑。只返回润色后的逐字稿正文，不要解释，不要写标题，不要使用 Markdown 代码围栏，不要添加原文没有的事实。
任务是把整段口语字幕编辑成“忠于原意、标点完整、可以直接阅读的高质量中文逐字稿”，不是摘要。

内容规则：
1. 利用整段上下文恢复自然标点。完整陈述必须有句末标点，疑问句使用问号；不能出现超过约 90 个汉字仍没有任何标点的文字墙。
2. 删除纯粹无意义的口吃、机械重复和语气填充，但保留观点、事实、数字、例子、态度、转折与有效口语风格，不得压缩成摘要。
3. 修正结合上下文能够确定的明显同音错字、断词和中英文混写，例如把被误识别的常见 AI/Agent/Intelligence/Intensity 等术语恢复成合理写法；无法确定时保持原意，不要猜造事实。
4. 输入已由系统切成 blockCount 个连续编辑块，separator 是块与块之间的唯一边界。必须按原顺序逐块编辑，返回数量完全相同的块，并在相邻输出块之间原样保留 separator；不得合并、拆分、跳过或跨块搬运内容。
5. 每个输出块的正文长度应为对应原块的 75%-120%，全文总长度应为 inputChars 的 75%-120%。不要输出块编号、引号、列表符号或其他包装。
6. 这是逐字稿编辑，不是章节摘要。不要把问答改写成“某人认为、主持人补充”等概述；原文中的观点、事实、数字、例子、问题、回答、转折和论证过程都要保留。只删除口吃、无意义语气词和紧邻的机械重复。
7. 每个块本身就是一个阅读段落。让该段落语句完整、衔接自然；除非原文本身已可直接阅读，否则禁止整块原样照抄。

输出格式示例（假设 separator 是 §）：第一块润色正文。§第二块润色正文。§第三块润色正文。`,
    outline: `${base}
任务是生成“短版但有信息量”的文字大纲，不是逐段复述字幕。先判断视频中心论点，再按视频论述顺序提炼最重要的章节。transcript 是压缩摘录，每行都以 [segmentIndex=N] 开头；segmentIndexes 只能填写这些 N。
这是严格的短输出协议，必须全部遵守：
1. JSON 总长度不超过 ${OUTLINE_RESULT_MAX_CHARS} 个字符，优先控制在 900 tokens 以内；达到上限立即停止，不要补充说明。
2. items 只保留 5 个一级节点（素材不足时可为 3-4 个），最多 1 个二级节点；二级节点的 children 必须为空。
3. 根 title 不超过 24 字，根 summary 不超过 45 字；每个节点 title 不超过 16 字，summary 只写一句且不超过 32 字。
4. 每个节点最多 1 条 keyPoints，每条不超过 20 字；每个节点最多引用 2 个 segmentIndexes。
5. 只输出 title、summary、items 以及节点要求的字段，不要输出长段落、背景铺垫、套话、重复观点或额外字段。
重点回答“讲了什么、核心结论是什么、有什么依据或建议”。返回 JSON：{"title":"中心标题","summary":"全片核心结论","items":[{"id":"outline-1","title":"章节主题","summary":"一句话说明本章核心内容","keyPoints":["关键论点"],"segmentIndexes":[0],"children":[{"id":"outline-1-1","title":"子主题","summary":"一句话说明子主题","keyPoints":["具体结论"],"segmentIndexes":[1],"children":[]}]}]}。`,
    mindmap: `${base}
任务是生成真正的概念关系思维导图，不要把文字大纲换个名字再输出。思维导图要围绕一个中心主题，组织 6-10 个一级概念分支，并为重要分支补充 1-3 个子概念；优先表达“是什么、为什么、影响、对比、因果、方法、案例、行动”等关系。节点 label 要短而有辨识度，summary 解释该概念在全片中的含义，relation 用“包含/导致/对比/依赖/建议/例证”等词说明它和父节点的关系，keywords 提取 2-5 个关键词。不要把时间戳或 segmentId 写进可见文字。
每个节点必须包含 id、label、summary、relation、keywords、segmentIndexes、children。segmentIndexes 只用于内部溯源，可以为空；children 用于表达层级。根节点也要有 summary。请保证不同一级分支之间是概念上的分类或关系，而不是按字幕顺序机械罗列。
返回 JSON：{"id":"root","label":"中心主题","summary":"一句话总括","relation":"","keywords":["关键词"],"segmentIndexes":[],"children":[{"id":"branch-1","label":"核心概念","summary":"该概念的含义和作用","relation":"包含","keywords":["关键词"],"segmentIndexes":[0],"children":[{"id":"branch-1-1","label":"子概念","summary":"子概念与父概念的关系","relation":"导致","keywords":["关键词"],"segmentIndexes":[1],"children":[]}]}]}。`,
    structure: `${base}
任务是同时生成两个不同用途的结构，而且输入 transcript 已经是 AI 润色版。文字大纲负责按视频论述顺序完整复盘，思维导图负责把内容抽象成概念、分类和关系；两者不能使用同一套节点标题，也不能只输出寥寥几个词。
文字大纲要求：中心标题 + 8-12 个一级章节；每章 1-3 个子节点；每个节点包含 title、summary、keyPoints、segmentIndexes、children。summary 写完整解释，keyPoints 写具体论点/依据/例子/结论/行动建议。
思维导图要求：中心主题 + 6-10 个概念分支；重要分支 1-3 层；每个节点包含 label、summary、relation、keywords、segmentIndexes、children。用概念关系、因果、对比、影响和方法组织，不要复制文字大纲，不要在可见文字中写时间戳或 segmentId。
两个结果都必须引用支持内容的字幕行号；segmentIndexes 可以为空，但禁止凭空添加事实。返回 JSON：{"outline":{"title":"中心标题","summary":"全片核心结论","items":[{"id":"outline-1","title":"章节主题","summary":"完整解释","keyPoints":["具体论点"],"segmentIndexes":[0],"children":[]}]}, "mindmap":{"id":"root","label":"中心主题","summary":"一句话总括","relation":"","keywords":["关键词"],"segmentIndexes":[],"children":[{"id":"branch-1","label":"核心概念","summary":"概念解释","relation":"包含","keywords":["关键词"],"segmentIndexes":[0],"children":[]}]}}。`,
    outline_chunk: `${base}任务是从一个字幕分块中提取章节候选。只返回 {\"chapters\":[{\"id\":\"chapter-1\",\"title\":\"短标题\",\"summary\":\"一句话摘要\",\"keyPoints\":[\"关键点\"],\"segmentIds\":[\"输入中的ID\"]}]}。每个候选必须引用输入中的 segmentIds，最多 6 个候选，不能编造引用。`,
    mindmap_chunk: `${base}任务是从一个字幕分块中提取概念候选。只返回 {\"concepts\":[{\"id\":\"concept-1\",\"label\":\"短概念\",\"summary\":\"概念含义\",\"relation\":\"包含/导致/对比/建议/例证\",\"keywords\":[\"关键词\"],\"segmentIds\":[\"输入中的ID\"]}]}。每个候选必须引用输入中的 segmentIds，最多 8 个候选，不能编造引用。`,
    outline_merge: `${base}任务是把多个分块章节候选合并为完整文字大纲。输入的 chunks 只有分块摘要和合法引用，不能要求或假设还有完整原文；可结合 boundedSample 判断全片顺序。去除重复节点，保留有信息量的章节。返回 {\"title\":\"中心标题\",\"summary\":\"全片核心结论\",\"items\":[{\"id\":\"outline-1\",\"title\":\"章节主题\",\"summary\":\"完整解释\",\"keyPoints\":[\"具体论点\"],\"segmentIds\":[\"候选中出现的ID\"],\"children\":[]}]}。最多 12 个一级节点、每个最多 3 个子节点，只能使用输入里出现过的 segmentIds。`,
    mindmap_merge: `${base}任务是把多个分块概念候选合并为概念关系思维导图。输入的 chunks 只有分块摘要，不能重新索取或假设完整原文。去重并表达是什么、因果、对比、影响、方法和行动。返回 {\"id\":\"root\",\"label\":\"中心主题\",\"summary\":\"一句话总括\",\"relation\":\"\",\"keywords\":[\"关键词\"],\"segmentIds\":[],\"children\":[{\"id\":\"branch-1\",\"label\":\"核心概念\",\"summary\":\"概念解释\",\"relation\":\"包含\",\"keywords\":[\"关键词\"],\"segmentIds\":[\"候选中出现的ID\"],\"children\":[]}]}。最多 10 个一级分支、每个最多 3 个子概念，只能使用输入里出现过的 segmentIds。`,
    knowledge_chunk: `${base}
任务是对一个字幕分块做“知识资料整理”，不做全局总结。尽可能完整提取事实、观点、推测、方法、案例、问题和反方观点。
硬规则：coverage 必须原样返回 chunkId、firstSegmentId、lastSegmentId、segmentCount，omissionsChecked 必须为 true。每条 item 必须有输入中的 segmentIds；不冒充说话人，不引入外部事实。如果确实没有可沉淀知识，items 可为空，但 emptyReason 必须具体。type 只能是 fact/opinion/prediction/advice/example/question/counterpoint。
返回：{\"coverage\":{\"chunkId\":\"\",\"firstSegmentId\":\"\",\"lastSegmentId\":\"\",\"segmentCount\":0,\"omissionsChecked\":true},\"items\":[{\"id\":\"item-1\",\"type\":\"opinion\",\"title\":\"短标题\",\"statement\":\"可独立理解的结论\",\"explanation\":\"上下文、条件或理由\",\"speakerId\":\"\",\"speakerLabel\":\"\",\"segmentIds\":[\"原ID\"],\"concepts\":[\"概念\"],\"needsExternalVerification\":false}],\"concepts\":[{\"label\":\"概念\",\"definition\":\"本视频中的含义\",\"segmentIds\":[\"原ID\"]}],\"emptyReason\":\"\"}。`
  };
  return prompts[operation] || base;
}

function getAiBaseUrl() {
  return safeString(loadSettings().aiBaseUrl).replace(/\/$/, "");
}

let aiCallOverride = null;

async function readCanvasLlmStream(response, context = {}) {
  if (!response.body?.getReader) {
    throw new AppError("AI_STREAM_UNAVAILABLE", "AI 底座没有返回可读取的流式正文。", { ...context, retryable: true }, 502);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let conversation = null;
  const consumeEvent = (eventText) => {
    const line = eventText.split("\n").find((item) => item.startsWith("data:"));
    if (!line) return;
    let event;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      throw new AppError("AI_INVALID_STREAM_EVENT", "AI 底座返回了无法识别的流式事件。", { ...context, retryable: true }, 502);
    }
    if (event.type === "delta") fullText += safeString(event.delta);
    if (event.type === "meta" || event.type === "done") conversation = event.conversation || conversation;
    if (event.type === "error") {
      const detail = redactLogText(event.detail || event.message || "AI 流式生成失败。");
      if (/524|origin_response_timeout/i.test(detail)) {
        throw new AppError("AI_CLOUDFLARE_524", "AI 上游等待超时（Cloudflare 524）。", { ...context, retryable: true }, 504);
      }
      throw new AppError("AI_UPSTREAM", detail, { ...context, retryable: true }, 502);
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      consumeEvent(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode().replace(/\r\n/g, "\n");
  if (buffer.trim()) consumeEvent(buffer);
  if (!fullText && Array.isArray(conversation?.messages)) {
    const lastAssistant = [...conversation.messages].reverse().find((message) => message?.role === "assistant");
    fullText = safeString(lastAssistant?.content || lastAssistant?.text);
  }
  if (!fullText) throw new AppError("AI_EMPTY", "AI 底座流式生成结束但没有返回正文。", { ...context, retryable: true }, 502);
  return { text: fullText, model: safeString(context.model) };
}

async function callCanvasLlm({ operation, engine, message, systemPrompt, provider = "", model = "" }) {
  if (aiCallOverride) return aiCallOverride({ operation, engine, message, systemPrompt, provider, model });
  const baseUrl = getAiBaseUrl();
  if (!baseUrl) {
    throw new AppError("AI_BASE_NOT_CONFIGURED", "还没有配置 AI 底座地址，请在设置中填写 VIDEO_AI_BASE_URL 对应的地址。", {}, 503);
  }
  const settings = loadSettings();
  const selectedProvider = engine === "codex" ? "codex" : safeString(provider || settings.aiProvider);
  const selectedModel = safeString(model || settings.aiModel);
  let response;
  try {
    response = await fetch(`${baseUrl}/api/canvas-llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30 * 60 * 1000),
      body: JSON.stringify({
        message,
        system_prompt: systemPrompt,
        provider: selectedProvider,
        model: selectedModel,
        messages: []
      })
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new AppError("AI_TIMEOUT", "AI 请求超时，已保留已完成的分块；可以稍后只重试失败分块。", { operation, engine, retryable: true }, 504);
    }
    throw new AppError("AI_UPSTREAM_DISCONNECTED", "AI 上游连接中断，已保留已完成的分块；可以重试。", { operation, engine, retryable: true, cause: redactLogText(error?.message) }, 502);
  }

  const rawBody = await response.text().catch(() => "");
  let payload = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    if (!response.ok) {
      throw new AppError("AI_UPSTREAM", `AI 底座返回 HTTP ${response.status}，且错误响应不是有效 JSON。`, { operation, engine, status: response.status }, response.status);
    }
    throw new AppError("AI_INVALID_UPSTREAM_JSON", "AI 底座返回的响应不是有效 JSON。", { operation, engine }, 502);
  }
  if (!response.ok) {
    if (response.status === 524 || payload.error_code === 524 || payload.error_name === "origin_response_timeout") {
      throw new AppError("AI_CLOUDFLARE_524", "AI 上游等待超时（Cloudflare 524），已保留已完成的分块；请稍后重试。", { operation, engine, status: 524, retryable: true }, 504);
    }
    const upstreamMessage = payload.detail || payload.message || payload.error || `AI 底座返回 HTTP ${response.status}。`;
    throw new AppError("AI_UPSTREAM", redactLogText(upstreamMessage), { operation, engine, status: response.status, retryable: response.status >= 500 }, response.status);
  }
  if (!safeString(payload.text)) throw new AppError("AI_EMPTY", "AI 底座返回了空结果，已保留已完成的分块；可以重试。", { operation, engine, retryable: true }, 502);
  return payload;
}

async function loadAiEngines() {
  const baseUrl = getAiBaseUrl();
  const settings = loadSettings();
  const result = {
    configured: Boolean(baseUrl),
    baseUrl,
    providers: [],
    defaultProvider: safeString(settings.aiProvider),
    defaultModel: safeString(settings.aiModel),
    codex: { installed: false, logged_in: false, message: "未检查" }
  };
  if (!baseUrl) return result;
  try {
    const providersResponse = await fetch(`${baseUrl}/api/providers`, { signal: AbortSignal.timeout(10000) });
    const providers = await providersResponse.json();
    result.providers = providers.providers || [];
    if (!result.defaultProvider) {
      const fallback = result.providers.find((item) => item?.enabled !== false && item?.primary)
        || result.providers.find((item) => item?.enabled !== false && item?.id !== "modelscope" && !["codex", "gemini-cli"].includes(item?.protocol))
        || result.providers.find((item) => item?.enabled !== false);
      result.defaultProvider = safeString(fallback?.id);
    }
    if (!result.defaultModel) {
      const fallback = result.providers.find((item) => item?.id === result.defaultProvider);
      result.defaultModel = safeString(fallback?.chat_models?.[0] || fallback?.chatModels?.[0]);
    }
    if (!result.defaultModel) {
      try {
        const modelsResponse = await fetch(`${baseUrl}/api/models`, { signal: AbortSignal.timeout(10000) });
        const modelsPayload = await modelsResponse.json();
        result.defaultModel = safeString(modelsPayload.chat_models?.[0] || modelsPayload.chatModels?.[0]);
      } catch {
        // /api/providers 已经足够渲染平台和平台自带模型；默认模型接口失败时保留空值。
      }
    }
  } catch (error) {
    result.providerError = error.message;
  }
  try {
    const codexResponse = await fetch(`${baseUrl}/api/codex/status`, { signal: AbortSignal.timeout(10000) });
    result.codex = await codexResponse.json();
  } catch (error) {
    result.codex = { installed: false, logged_in: false, message: error.message };
  }
  return result;
}

function analysisTrackIdentity(track) {
  return [
    safeString(track?.language || track?.languageName || track?.label || track?.id),
    track?.isAI ? "ai" : "public"
  ].join("|");
}

function analysisSourceKey(page, track) {
  const trackKey = safeString(track?.id || track?.language || track?.languageName || "track")
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  return `p${Number(page?.page || 1)}::${trackKey}`;
}

function buildAnalysisInput(note, pageIndex, trackIndex, pageScope = "current", trackScope = "current") {
  const pages = note.transcript?.original?.pages || [];
  const selectedPage = pages[pageIndex] || pages[0];
  const selectedTrack = selectedPage?.subtitles?.[trackIndex] || selectedPage?.subtitles?.[0];
  if (!selectedPage || !selectedTrack) throw new AppError("NO_TRANSCRIPT", "当前笔记没有可供 AI 处理的字幕。", {}, 422);

  const selectedIdentity = analysisTrackIdentity(selectedTrack);
  const targetPages = pageScope === "all" ? pages : [selectedPage];
  const sources = [];
  const segments = [];

  targetPages.forEach((page) => {
    const pageTracks = page.subtitles || [];
    const targetTracks = trackScope === "all"
      ? pageTracks
      : pageTracks.filter((track) => page === selectedPage || analysisTrackIdentity(track) === selectedIdentity).slice(0, 1);
    targetTracks.forEach((track) => {
      const sourceKey = analysisSourceKey(page, track);
      const source = {
        sourceKey,
        pageIndex: pages.indexOf(page),
        page: Number(page.page || 1),
        cid: Number(page.cid || 0),
        part: page.part,
        trackId: safeString(track.id),
        language: safeString(track.language),
        languageName: safeString(track.languageName),
        label: safeString(track.label),
        isAI: Boolean(track.isAI)
      };
      const sourceSegments = flattenSegments(track).map((segment) => ({
        ...segment,
        pageIndex: source.pageIndex,
        page: source.page,
        part: source.part,
        trackId: source.trackId,
        sourceKey,
        language: source.language,
        languageName: source.languageName
      }));
      if (!sourceSegments.length) return;
      sources.push({ ...source, segmentCount: sourceSegments.length });
      segments.push(...sourceSegments);
    });
  });

  if (!segments.length) throw new AppError("NO_TRANSCRIPT", "选定的处理范围没有可用字幕片段。", {}, 422);
  return {
    source: sources.length === 1
      ? { title: note.title, provider: sourceProvider(note), sourceId: sourceId(note), bvid: note.source.bvid, ...sources[0] }
      : { title: note.title, provider: sourceProvider(note), sourceId: sourceId(note), bvid: note.source.bvid, scope: { pageScope, trackScope } },
    sources,
    segments,
    scope: { pageScope, trackScope },
    selected: { pageIndex, trackIndex, sourceKey: analysisSourceKey(selectedPage, selectedTrack) }
  };
}

function buildPolishedStructureInput(note, input) {
  const polished = note.transcript?.polished;
  if (polished?.status !== "ready") {
    throw new AppError("POLISHED_NOT_READY", "请先生成当前字幕范围的 AI 润色版，再生成文字大纲和思维导图。", {}, 422);
  }

  const polishedSegments = [];
  const missingSources = [];
  for (const source of input.sources) {
    const variant = polished.variants?.[source.sourceKey];
    const originals = input.segments.filter((segment) => segment.sourceKey === source.sourceKey);
    const paragraphs = Array.isArray(variant?.paragraphs)
      ? variant.paragraphs
      : input.sources.length === 1 && Array.isArray(polished.paragraphs)
        ? polished.paragraphs
        : [];
    if (paragraphs.length) {
      const coveredIds = paragraphs.flatMap((paragraph) => Array.isArray(paragraph.sourceSegmentIds) ? paragraph.sourceSegmentIds.map(safeString) : []);
      const originalIds = originals.map((segment) => safeString(segment.id || segment.segmentId));
      if (coveredIds.length === originalIds.length && coveredIds.every((id, index) => id === originalIds[index])) {
        polishedSegments.push(...paragraphs.map(normalizeAnalysisSegment));
        continue;
      }
      missingSources.push(source.sourceKey);
      continue;
    }
    const candidates = Array.isArray(variant?.segments)
      ? variant.segments
      : input.sources.length === 1 && Array.isArray(polished.segments)
        ? polished.segments
        : [];
    const byId = new Map(candidates.map((segment) => [safeString(segment.id || segment.segmentId), segment]));
    const mapped = originals.map((original, index) => {
      const replacement = byId.get(original.id) || candidates[index];
      const text = safeString(replacement?.text);
      return text ? { ...original, text, originalText: safeString(original.text) } : null;
    });
    if (mapped.some((segment) => !segment)) {
      missingSources.push(source.sourceKey);
      continue;
    }
    polishedSegments.push(...mergePolishedParagraphSegments(mapped));
  }

  if (missingSources.length) {
    throw new AppError("POLISHED_SCOPE_NOT_READY", "当前处理范围没有完整的 AI 润色版，请先按当前 P 和字幕轨道生成润色。", { missingSources }, 422);
  }
  return { ...input, segments: polishedSegments };
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function speakerBySourceSegment(note) {
  const output = new Map();
  for (const variant of Object.values(note.transcript?.speaker?.variants || {})) {
    for (const segment of variant?.segments || []) {
      const ids = Array.isArray(segment.sourceSegmentIds)
        ? segment.sourceSegmentIds
        : [segment.sourceSegmentId || segment.segmentId || segment.id];
      for (const segmentId of ids.map(safeString).filter(Boolean)) {
        output.set(`${safeString(variant.sourceKey)}::${segmentId}`, {
          speakerId: safeString(segment.speakerId),
          speakerLabel: safeString(note.speaker?.labels?.[segment.speakerId] || segment.speakerLabel || segment.speakerId)
        });
      }
    }
  }
  return output;
}

function buildSpeakerKnowledgeInput(note, originalInput) {
  const segments = [];
  const missingSources = [];
  const originalsBySource = new Map();
  for (const source of originalInput.sources) {
    originalsBySource.set(source.sourceKey, new Map(
      originalInput.segments
        .filter((segment) => segment.sourceKey === source.sourceKey)
        .map((segment) => [safeString(segment.id || segment.segmentId), segment])
    ));
    const variant = note.transcript?.speaker?.variants?.[source.sourceKey];
    const merged = Array.isArray(variant?.segments) ? variant.segments : [];
    if (!merged.length) {
      missingSources.push(source.sourceKey);
      continue;
    }
    const originalMap = originalsBySource.get(source.sourceKey);
    for (const [index, item] of merged.entries()) {
      const sourceSegmentIds = [...new Set((item.sourceSegmentIds || []).map(safeString).filter(Boolean))];
      const firstOriginal = originalMap.get(sourceSegmentIds[0]) || {};
      const normalized = normalizeAnalysisSegment({
        ...firstOriginal,
        ...item,
        id: safeString(item.id) || `speaker-paragraph-${index + 1}`,
        segmentId: safeString(item.id) || `speaker-paragraph-${index + 1}`,
        page: source.page,
        pageIndex: source.pageIndex,
        trackId: source.trackId,
        track: source.languageName || source.label || source.trackId,
        sourceKey: source.sourceKey
      }, index);
      segments.push({
        ...normalized,
        sourceSegmentIds,
        originalText: cleanSpeakerJoin(sourceSegmentIds.map((segmentId) => originalMap.get(segmentId)?.text)),
        speakerId: safeString(item.speakerId) || "speaker_unknown",
        speakerLabel: safeString(note.speaker?.labels?.[item.speakerId] || item.speakerLabel || item.speakerId || "未确定")
      });
    }
  }
  if (missingSources.length) {
    throw new AppError("SPEAKER_SCOPE_NOT_READY", "当前处理范围还没有说话人版，请先生成对应 P 和字幕轨道的说话人版，或改选 AI 润色版。", { missingSources }, 422);
  }
  return { ...originalInput, segments };
}

function assertKnowledgeSourceCoverage(originalInput, selectedSegments) {
  const expectedKeys = originalInput.segments.map((segment) => `${segment.sourceKey}::${safeString(segment.id || segment.segmentId)}`);
  const counts = new Map();
  for (const segment of selectedSegments) {
    const sourceKey = safeString(segment.sourceKey);
    const sourceSegmentIds = Array.isArray(segment.sourceSegmentIds) && segment.sourceSegmentIds.length
      ? segment.sourceSegmentIds
      : [segment.id || segment.segmentId];
    for (const sourceSegmentId of sourceSegmentIds.map(safeString).filter(Boolean)) {
      const key = `${sourceKey}::${sourceSegmentId}`;
      counts.set(key, Number(counts.get(key) || 0) + 1);
    }
  }
  const expected = new Set(expectedKeys);
  const missingSourceSegmentIds = expectedKeys.filter((key) => !counts.has(key));
  const duplicateSourceSegmentIds = [...counts.entries()].filter(([key, count]) => expected.has(key) && count !== 1).map(([key]) => key);
  const unknownSourceSegmentIds = [...counts.keys()].filter((key) => !expected.has(key));
  if (missingSourceSegmentIds.length || duplicateSourceSegmentIds.length || unknownSourceSegmentIds.length) {
    throw new AppError(
      "KNOWLEDGE_SOURCE_COVERAGE_INCOMPLETE",
      "所选字幕版本没有完整、唯一地覆盖源字幕，API 整理已停止。请先重新生成该版本，系统不会带着缺口继续合成。",
      { missingSourceSegmentIds, duplicateSourceSegmentIds, unknownSourceSegmentIds },
      422
    );
  }
  return expectedKeys.length;
}

function buildKnowledgeInput(note, options = {}) {
  const pageIndex = Math.max(0, Number(options.pageIndex || 0));
  const trackIndex = Math.max(0, Number(options.trackIndex || 0));
  const pageScope = options.pageScope === "current" ? "current" : "all";
  const trackScope = options.trackScope === "all" ? "all" : "current";
  const transcriptMode = ["original", "speaker"].includes(options.transcriptMode) ? options.transcriptMode : "polished";
  const originalInput = buildAnalysisInput(note, pageIndex, trackIndex, pageScope, trackScope);
  const selectedInput = transcriptMode === "polished"
    ? buildPolishedStructureInput(note, originalInput)
    : transcriptMode === "speaker"
      ? buildSpeakerKnowledgeInput(note, originalInput)
      : originalInput;
  // 原始字幕往往是十几个字一条。先在本地确定性合并为连续证据段，
  // 每条源 ID 仍保留于 sourceSegmentIds，避免为了传输短句元数据浪费 API 请求。
  const knowledgeReadySegments = transcriptMode === "original"
    ? mergePolishedParagraphSegments(selectedInput.segments, {
      maxChars: 420,
      maxSeconds: 120,
      maxSentences: 12,
      maxGapSeconds: 5
    })
    : selectedInput.segments;
  const originals = new Map(originalInput.segments.map((segment) => [stableSegmentKey(segment), safeString(segment.text)]));
  const speakers = speakerBySourceSegment(note);
  const segments = knowledgeReadySegments.map((segment, index) => {
    const normalized = normalizeAnalysisSegment(segment, index);
    const speaker = transcriptMode === "speaker" ? speakers.get(`${normalized.sourceKey}::${normalized.segmentId}`) || {} : {};
    return {
      ...normalized,
      sourceSegmentIds: [...new Set((segment.sourceSegmentIds || [normalized.segmentId]).map(safeString).filter(Boolean))],
      originalText: safeString(segment.originalText || originals.get(stableSegmentKey(normalized)) || normalized.text),
      speakerId: safeString(segment.speakerId || speaker.speakerId),
      speakerLabel: safeString(segment.speakerLabel || speaker.speakerLabel)
    };
  });
  const sourceSegmentCount = assertKnowledgeSourceCoverage(originalInput, segments);
  const sourceDescriptors = selectedInput.sources.map((source) => {
    const sourceSegments = segments.filter((segment) => segment.sourceKey === source.sourceKey);
    return {
      ...source,
      segmentCount: sourceSegments.length,
      firstSegmentId: sourceSegments[0]?.segmentId || "",
      lastSegmentId: sourceSegments.at(-1)?.segmentId || "",
      contentHash: sha256Json(sourceSegments.map((segment) => [segment.segmentId, segment.text, segment.speakerId]))
    };
  });
  const snapshotCore = {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    noteId: note.id,
    provider: sourceProvider(note),
    sourceId: sourceId(note),
    bvid: safeString(note.source?.bvid),
    transcriptMode,
    scope: selectedInput.scope,
    selected: selectedInput.selected,
    sourceSegmentCount,
    sources: sourceDescriptors,
    segments
  };
  return {
    ...selectedInput,
    segments,
    transcriptMode,
    sourceSegmentCount,
    snapshotHash: sha256Json(snapshotCore),
    snapshotCore
  };
}

function invalidateKnowledge(note, reason) {
  if (!note.knowledge || note.knowledge.status === "not_started") return note;
  note.knowledge.status = "stale";
  note.knowledge.staleReason = safeString(reason || "源资料已变更");
  note.knowledge.staleAt = now();
  if (note.knowledge.audit) note.knowledge.audit.status = "stale";
  return note;
}

function outlineExcerptText(value, maxChars) {
  return safeString(value)
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, maxChars)
    .trim();
}

function outlineBucketCandidates(records, count) {
  if (count <= 1) return records.slice().sort((a, b) => b.length - a.length).slice(0, 1);
  const candidates = [records[0], records.slice().sort((a, b) => b.length - a.length)[0], records[records.length - 1]];
  const unique = new Map(candidates.filter(Boolean).map((record) => [record.index, record]));
  return [...unique.values()].sort((a, b) => a.index - b.index).slice(0, count);
}

function buildOutlineTranscript(input) {
  const segments = Array.isArray(input?.segments) ? input.segments : [];
  if (!segments.length) return { text: "", segmentCount: 0 };

  // 按来源和一分钟时间窗取“开头、最长、结尾”三条，既覆盖全片又不把 1296 行全部塞给模型。
  const buckets = new Map();
  segments.forEach((segment, index) => {
    const sourceKey = safeString(segment.sourceKey || "source");
    const from = Number(segment.from);
    const bucketIndex = Number.isFinite(from) ? Math.floor(Math.max(0, from) / 60) : Math.floor(index / 20);
    const key = `${sourceKey}::${bucketIndex}`;
    const bucket = buckets.get(key) || { firstIndex: index, records: [] };
    bucket.firstIndex = Math.min(bucket.firstIndex, index);
    bucket.records.push({ index, text: safeString(segment.text), length: safeString(segment.text).length });
    buckets.set(key, bucket);
  });

  const orderedBuckets = [...buckets.values()].sort((a, b) => a.firstIndex - b.firstIndex);
  const makeLines = (perBucket, textChars) => orderedBuckets
    .flatMap((bucket) => outlineBucketCandidates(bucket.records, perBucket))
    .sort((a, b) => a.index - b.index)
    .map((record) => `[segmentIndex=${record.index}] ${outlineExcerptText(record.text, textChars)}`)
    .filter((line) => line.length > 18);

  const candidates = [
    makeLines(3, 58),
    makeLines(3, 42),
    makeLines(2, 48),
    makeLines(1, 62)
  ];
  for (const lines of candidates) {
    const text = lines.join("\n");
    if (text.length <= OUTLINE_TRANSCRIPT_MAX_CHARS) {
      return { text, segmentCount: lines.length };
    }
  }

  // 极长视频再做一次均匀抽样，保留开头、结尾和全片覆盖，不让输入逼近底座 20000 字符限制。
  const lines = candidates[candidates.length - 1];
  const maxLines = Math.max(1, Math.floor(OUTLINE_TRANSCRIPT_MAX_CHARS / 46));
  const stride = Math.max(1, Math.ceil(lines.length / maxLines));
  const sampled = lines.filter((line, index) => index % stride === 0 || index === lines.length - 1);
  const text = sampled.join("\n");
  if (text.length <= OUTLINE_TRANSCRIPT_MAX_CHARS) return { text, segmentCount: sampled.length };

  const compacted = sampled.map((line) => line.slice(0, 42));
  return { text: compacted.join("\n").slice(0, OUTLINE_TRANSCRIPT_MAX_CHARS), segmentCount: compacted.length };
}

function buildCompactAnalysisMessage(operation, input, note) {
  let start = 0;
  const sources = input.sources.map((source, sourceIndex) => {
    const count = Number(source.segmentCount || 0);
    const compactSource = {
      sourceIndex,
      start,
      page: source.page,
      part: safeString(source.part),
      language: safeString(source.languageName || source.language),
      trackId: safeString(source.trackId),
      count
    };
    start += count;
    return compactSource;
  });
  const outlineTranscript = operation === "outline" ? buildOutlineTranscript(input) : null;
  const transcript = outlineTranscript
    ? outlineTranscript.text
    : input.segments
      .map((segment) => safeString(segment.text).replace(/[\r\n]+/g, " "))
      .join("\n");

  return JSON.stringify({
    instruction: operation === "structure"
        ? "以下 transcript 是已经生成的 AI 润色版，请基于润色后的内容生成大纲和思维导图。"
      : operation === "outline"
          ? `以下 transcript 是已经生成的 AI 润色版压缩摘录，共 ${outlineTranscript.segmentCount} 条；请基于这些摘录生成短版文字大纲，并严格遵守系统提示中的输出长度限制。每行开头的 segmentIndex 是原字幕全局索引。`
          : operation === "mindmap"
            ? "以下 transcript 是已经生成的 AI 润色版，请基于润色后的内容生成思维导图。"
        : "",
    video: {
      title: safeString(note?.title),
      provider: sourceProvider(note),
      sourceId: sourceId(note),
      bvid: safeString(note?.source?.bvid || input.source?.bvid)
    },
    sources,
    scope: input.scope,
    transcript
  });
}

function estimateTokenCount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, Math.ceil(Math.max(0, value) / 2));
  return Math.max(1, Math.ceil(Array.from(String(value || "")).length / 2));
}

function estimateMixedLanguageTokens(value) {
  const text = String(value || "");
  const cjkChars = countTextMatches(text, /[\u3400-\u9fff]/gu);
  const remainingChars = Math.max(0, Array.from(text).length - cjkChars);
  return Math.max(1, Math.ceil(cjkChars * 0.8 + remainingChars / 4));
}

function stableSegmentKey(segment) {
  return `${safeString(segment.sourceKey || "source")}::${safeString(segment.id || segment.segmentId)}`;
}

function normalizeAnalysisSegment(segment, index) {
  const segmentId = safeString(segment?.id || segment?.segmentId);
  if (!segmentId) {
    throw new AppError("AI_INVALID_SEGMENT", `第 ${index + 1} 个字幕片段没有稳定 ID，无法安全分块。`, { index }, 422);
  }
  const text = safeString(segment?.text || segment?.content);
  if (!text) throw new AppError("AI_EMPTY_SEGMENT", `字幕片段 ${segmentId} 没有文字，无法处理。`, { segmentId }, 422);
  return {
    id: segmentId,
    segmentId,
    from: Number(segment.from || 0),
    to: Number(segment.to || 0),
    page: Number(segment.page || 1),
    pageIndex: Number(segment.pageIndex || 0),
    trackId: safeString(segment.trackId),
    track: safeString(segment.track || segment.languageName || segment.trackId || "字幕"),
    sourceKey: safeString(segment.sourceKey || "source"),
    text,
    sourceSegmentIds: [...new Set((Array.isArray(segment.sourceSegmentIds) ? segment.sourceSegmentIds : [segment.sourceSegmentId || segmentId]).map(safeString).filter(Boolean))],
    originalText: safeString(segment.originalText),
    speakerId: safeString(segment.speakerId),
    speakerLabel: safeString(segment.speakerLabel),
    paragraphBreak: Boolean(segment.paragraphBreak)
  };
}

function polishBoundaryScore(currentSegment, nextSegment) {
  const current = safeString(currentSegment?.text);
  const next = safeString(nextSegment?.text);
  const gap = Number(nextSegment?.from || 0) - Number(currentSegment?.to || 0);
  let score = gap >= 2 ? 4 : gap >= 0.8 ? 2 : 0;
  if (/(为什么|怎么办|怎么看|是什么|是不是|对不对|有没有|能不能|可以吗|吗|呢|吧|对吧|啊|呀)$/u.test(current)) score += 3;
  if (/^(对|好|所以|但是|不过|然后|那|接下来|另外|其实|我觉得|有一个问题|最后|首先|第二|第三)/u.test(next)) score += 2;
  return score;
}

function createPolishBlocks(segments) {
  const normalized = (segments || []).map(normalizeAnalysisSegment);
  const totalChars = normalized.reduce((sum, segment) => sum + segment.text.length, 0);
  // 短视频如果仍按长视频的 190 字切块，模型很容易自行合并过细段落。
  // 这里只放宽本地编辑块，不减少任何源字幕或正文。
  const targetChars = totalChars <= 4000 ? 360 : POLISH_BLOCK_TARGET_CHARS;
  const minChars = totalChars <= 4000 ? 240 : POLISH_BLOCK_MIN_CHARS;
  const maxChars = totalChars <= 4000 ? 480 : POLISH_BLOCK_MAX_CHARS;
  const blocks = [];
  let current = [];
  let currentChars = 0;
  const flush = () => {
    if (!current.length) return;
    const first = current[0];
    const last = current[current.length - 1];
    blocks.push({
      index: blocks.length,
      segments: current,
      text: current.map((segment) => segment.text).join(""),
      sourceKey: first.sourceKey,
      from: first.from,
      to: last.to,
      sourceSegmentIds: current.map((segment) => segment.segmentId)
    });
    current = [];
    currentChars = 0;
  };
  normalized.forEach((segment, index) => {
    current.push(segment);
    currentChars += segment.text.length;
    const next = normalized[index + 1];
    if (!next || next.sourceKey !== segment.sourceKey) return flush();
    const boundaryScore = polishBoundaryScore(segment, next);
    if (currentChars >= maxChars || (currentChars >= minChars && currentChars >= targetChars && boundaryScore >= 2)) flush();
  });
  flush();
  return blocks;
}

function createAnalysisChunks(inputSegments, operation = "") {
  const normalized = (Array.isArray(inputSegments) ? inputSegments : []).map(normalizeAnalysisSegment);
  if (!normalized.length) throw new AppError("NO_TRANSCRIPT", "选定的处理范围没有可用字幕片段。", {}, 422);
  if (operation === "polish") {
    const delimiter = ["¦", "§", "¶", "¤"].find((candidate) => normalized.every((segment) => !segment.text.includes(candidate)));
    if (!delimiter) throw new AppError("AI_POLISH_DELIMITER_CONFLICT", "字幕包含全部内部边界符，无法安全建立润色输入。", {}, 422);
    const blocks = createPolishBlocks(normalized);
    const totalChars = blocks.reduce((sum, block) => sum + block.text.length, 0);
    const plannedCalls = Math.min(POLISH_MAX_API_CALLS, Math.max(1, Math.ceil(totalChars / POLISH_REQUEST_TARGET_CHARS)));
    const targetChars = Math.ceil(totalChars / plannedCalls);
    const groups = [];
    let current = [];
    let currentChars = 0;
    for (const block of blocks) {
      if (current.length && groups.length < plannedCalls - 1 && currentChars + block.text.length > targetChars) {
        groups.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(block);
      currentChars += block.text.length;
    }
    if (current.length) groups.push(current);
    return groups.map((groupBlocks, index) => {
      const groupSegments = groupBlocks.flatMap((block) => block.segments);
      const sourceKeys = [...new Set(groupSegments.map((segment) => segment.sourceKey))];
      const sourceKey = sourceKeys.length === 1 ? sourceKeys[0] : "multiple-sources";
      const first = groupSegments[0];
      const transcript = groupBlocks.map((block) => block.text).join(delimiter);
      const digest = crypto.createHash("sha1").update(`${sourceKey}:${first.segmentId}`).digest("hex").slice(0, 10);
      const blocksWithLocalIndexes = groupBlocks.map((block, localIndex) => ({ ...block, localIndex }));
      return {
        id: `polish-${String(index + 1).padStart(3, "0")}-${digest}`,
        index,
        sourceKey,
        sourceKeys,
        segments: groupSegments,
        blocks: blocksWithLocalIndexes,
        blockCount: blocksWithLocalIndexes.length,
        delimiter,
        transcript,
        segmentCount: groupSegments.length,
        inputChars: transcript.length,
        inputTokens: estimateMixedLanguageTokens(transcript),
        payloadChars: transcript.length,
        status: "queued",
        attempts: 0,
        outputChars: 0,
        outputTokens: 0,
        error: null,
        output: null
      };
    });
  }
  const maxTextChars = AI_CHUNK_TEXT_MAX_CHARS;
  const maxPayloadChars = AI_CHUNK_PAYLOAD_MAX_CHARS;
  const maxSegments = AI_CHUNK_MAX_SEGMENTS;
  const chunks = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const first = current.segments[0];
    const digest = crypto.createHash("sha1")
      .update(`${current.sourceKey}:${first.segmentId}`)
      .digest("hex")
      .slice(0, 10);
    current.id = `chunk-${String(chunks.length + 1).padStart(3, "0")}-${digest}`;
    current.index = chunks.length;
    current.segmentCount = current.segments.length;
    current.sourceKeys = [...new Set(current.segments.map((segment) => segment.sourceKey))];
    current.inputChars = current.segments.reduce((sum, segment) => sum + segment.text.length, 0);
    current.inputTokens = estimateTokenCount(current.inputChars);
    current.status = "queued";
    current.attempts = 0;
    current.outputChars = 0;
    current.outputTokens = 0;
    current.error = null;
    current.output = null;
    chunks.push(current);
    current = null;
  };

  for (const segment of normalized) {
    if (segment.text.length > maxTextChars) {
      throw new AppError("AI_SEGMENT_TOO_LONG", `字幕片段 ${segment.segmentId} 太长，系统不会在句子中间硬切，请先拆分这条字幕后再处理。`, {
        segmentId: segment.segmentId,
        chars: segment.text.length,
        maxChars: maxTextChars
      }, 422);
    }
    const segmentChars = segment.text.length;
    const segmentPayloadChars = JSON.stringify(aiSegmentPayload(segment)).length + 1;
    const startsNewSource = current && current.sourceKey !== segment.sourceKey;
    const exceedsBudget = current && (
      current.segments.length >= maxSegments
      || current.inputChars + segmentChars > maxTextChars
      || current.payloadChars + segmentPayloadChars > maxPayloadChars
    );
    if (startsNewSource || exceedsBudget) flush();
    if (!current) current = { sourceKey: segment.sourceKey, segments: [], inputChars: 0, payloadChars: 500 };
    current.segments.push(segment);
    current.inputChars += segmentChars;
    current.payloadChars += segmentPayloadChars;
  }
  flush();

  if (chunks.length > AI_MAX_OUTLINE_CHUNKS) {
    throw new AppError("AI_TOO_MANY_CHUNKS", `字幕被切成 ${chunks.length} 个分块，超过当前任务上限；请缩小处理范围。`, {
      chunkCount: chunks.length,
      maxChunks: AI_MAX_OUTLINE_CHUNKS
    }, 422);
  }
  return chunks;
}

function createKnowledgeChunks(inputSegments) {
  const normalized = (Array.isArray(inputSegments) ? inputSegments : []).map((segment, index) => ({
    ...normalizeAnalysisSegment(segment, index),
    originalText: safeString(segment.originalText || segment.text),
    speakerId: safeString(segment.speakerId),
    speakerLabel: safeString(segment.speakerLabel)
  }));
  if (!normalized.length) throw new AppError("NO_TRANSCRIPT", "选定的处理范围没有可用字幕片段。", {}, 422);
  const entries = normalized.map((segment) => ({
    segment,
    payloadChars: JSON.stringify(knowledgeSegmentPayload(segment)).length + 1
  }));
  const sources = [];
  for (const entry of entries) {
    let source = sources.at(-1);
    if (!source || source.sourceKey !== entry.segment.sourceKey) {
      source = { sourceKey: entry.segment.sourceKey, entries: [], payloadChars: 0, calls: 1 };
      sources.push(source);
    }
    source.entries.push(entry);
    source.payloadChars += entry.payloadChars;
  }
  const estimatedPayloadChars = sources.reduce((sum, source) => sum + source.payloadChars + 700, 0);
  const plannedCalls = Math.max(sources.length, Math.ceil(estimatedPayloadChars / KNOWLEDGE_REQUEST_TARGET_CHARS));
  if (plannedCalls > KNOWLEDGE_MAX_API_CALLS) {
    throw new AppError(
      "KNOWLEDGE_SCOPE_TOO_LARGE",
      `当前范围预计需要 ${plannedCalls} 次 API 请求，超过 5 次费用上限，系统已停止。请改为“当前 P”或“当前轨道”后再试。`,
      { estimatedCalls: plannedCalls, maxCalls: KNOWLEDGE_MAX_API_CALLS, estimatedPayloadChars },
      422
    );
  }

  let callsToAllocate = plannedCalls - sources.length;
  while (callsToAllocate > 0) {
    const source = [...sources].sort((a, b) => (b.payloadChars / b.calls) - (a.payloadChars / a.calls))[0];
    source.calls += 1;
    callsToAllocate -= 1;
  }
  const groups = sources.flatMap((source) => {
    const output = [];
    let current = [];
    let currentPayloadChars = 0;
    const balancedTarget = Math.ceil(source.payloadChars / source.calls);
    for (const [index, entry] of source.entries.entries()) {
      const groupsStillNeeded = source.calls - output.length;
      const entriesRemaining = source.entries.length - index;
      const mustKeepForLaterGroups = entriesRemaining <= groupsStillNeeded - 1;
      if (current.length
        && output.length < source.calls - 1
        && (currentPayloadChars + entry.payloadChars > balancedTarget || mustKeepForLaterGroups)) {
        output.push(current);
        current = [];
        currentPayloadChars = 0;
      }
      current.push(entry.segment);
      currentPayloadChars += entry.payloadChars;
    }
    if (current.length) output.push(current);
    return output;
  });
  if (groups.length > KNOWLEDGE_MAX_API_CALLS) {
    throw new AppError("KNOWLEDGE_SCOPE_TOO_LARGE", `当前范围需要 ${groups.length} 次 API 请求，超过 5 次费用上限，系统已停止。`, {
      estimatedCalls: groups.length,
      maxCalls: KNOWLEDGE_MAX_API_CALLS
    }, 422);
  }

  return groups.map((segments, index) => {
    const first = segments[0];
    const digest = crypto.createHash("sha1").update(`${first.sourceKey}:${first.segmentId}`).digest("hex").slice(0, 10);
    const segmentIds = segments.map((segment) => segment.segmentId);
    const chunk = {
      id: `knowledge-${String(index + 1).padStart(3, "0")}-${digest}`,
      index,
      sourceKey: first.sourceKey,
      sourceKeys: [...new Set(segments.map((segment) => segment.sourceKey))],
      segments,
      segmentCount: segments.length,
      segmentIds,
      firstSegmentId: segmentIds[0],
      lastSegmentId: segmentIds.at(-1),
      inputChars: segments.reduce((sum, segment) => sum + segment.text.length, 0),
      payloadChars: segments.reduce((sum, segment) => sum + JSON.stringify(knowledgeSegmentPayload(segment)).length + 1, 700),
      inputHash: sha256Json(segments.map((segment) => [segment.segmentId, segment.text, segment.speakerId])),
      status: "queued",
      attempts: 0,
      outputChars: 0,
      outputTokens: 0,
      error: null,
      output: null
    };
    chunk.inputTokens = estimateMixedLanguageTokens(JSON.stringify({
      system: aiSystemPrompt("knowledge_chunk"),
      message: buildKnowledgeChunkMessage(chunk, null)
    }));
    return chunk;
  });
}

function aiSegmentPayload(segment) {
  const payload = {
    segmentId: segment.segmentId,
    from: segment.from,
    to: segment.to,
    page: segment.page,
    track: segment.track,
    trackId: segment.trackId,
    sourceKey: segment.sourceKey,
    text: segment.text
  };
  if (Array.isArray(segment.sourceSegmentIds) && (segment.sourceSegmentIds.length > 1 || segment.sourceSegmentIds[0] !== segment.segmentId)) {
    payload.sourceSegmentIds = segment.sourceSegmentIds;
  }
  return payload;
}

function knowledgeSegmentPayload(segment) {
  return {
    segmentId: segment.segmentId,
    from: Number(Number(segment.from || 0).toFixed(2)),
    to: Number(Number(segment.to || segment.from || 0).toFixed(2)),
    text: segment.text,
    ...(safeString(segment.speakerId) ? { speakerId: safeString(segment.speakerId) } : {}),
    ...(safeString(segment.speakerLabel) ? { speakerLabel: safeString(segment.speakerLabel) } : {})
  };
}

function buildKnowledgeChunkMessage(chunk, note) {
  const message = JSON.stringify({
    instruction: "逐项整理本分块的知识资料；这不是全片总结。",
    video: { title: safeString(note?.title), provider: sourceProvider(note), sourceId: sourceId(note), bvid: safeString(note?.source?.bvid) },
    coverage: {
      chunkId: chunk.id,
      firstSegmentId: chunk.firstSegmentId,
      lastSegmentId: chunk.lastSegmentId,
      segmentCount: chunk.segmentCount
    },
    source: {
      sourceKey: safeString(chunk.sourceKey),
      page: chunk.segments[0]?.page,
      track: safeString(chunk.segments[0]?.track)
    },
    segments: chunk.segments.map(knowledgeSegmentPayload)
  });
  if (message.length > KNOWLEDGE_REQUEST_MAX_CHARS) {
    throw new AppError("KNOWLEDGE_REQUEST_TOO_LARGE", "单次知识整理请求超过安全长度，系统已在付费调用前停止。", {
      inputChars: message.length,
      maxChars: KNOWLEDGE_REQUEST_MAX_CHARS,
      retryable: false
    }, 422);
  }
  return message;
}

function normalizeKnowledgeReferenceIds(values, chunk, field = "segmentIds") {
  const allowed = new Set(chunk.segmentIds);
  const ids = [...new Set((Array.isArray(values) ? values : []).map(safeString).filter(Boolean))];
  const invalid = ids.filter((segmentId) => !allowed.has(segmentId));
  if (invalid.length) throw new AppError("KNOWLEDGE_INVALID_REFERENCE", `资料分块 ${chunk.id} 引用了不存在的字幕。`, { chunkId: chunk.id, field, invalid }, 502);
  return ids;
}

function normalizeKnowledgeChunkResponse(parsed, chunk) {
  const coverage = parsed?.coverage || {};
  const exactCoverage = safeString(coverage.chunkId) === chunk.id
    && safeString(coverage.firstSegmentId) === chunk.firstSegmentId
    && safeString(coverage.lastSegmentId) === chunk.lastSegmentId
    && Number(coverage.segmentCount) === chunk.segmentCount
    && coverage.omissionsChecked === true;
  if (!exactCoverage) {
    throw new AppError("KNOWLEDGE_COVERAGE_MISMATCH", `资料分块 ${chunk.id} 没有完整确认覆盖范围，已拒绝保存。`, { expected: {
      chunkId: chunk.id, firstSegmentId: chunk.firstSegmentId, lastSegmentId: chunk.lastSegmentId, segmentCount: chunk.segmentCount
    }, actual: coverage }, 502);
  }
  const allowedTypes = new Set(["fact", "opinion", "prediction", "advice", "example", "question", "counterpoint"]);
  const rawItems = Array.isArray(parsed?.items) ? parsed.items : null;
  if (!rawItems) throw new AppError("KNOWLEDGE_ITEMS_MISSING", `资料分块 ${chunk.id} 缺少 items 数组。`, {}, 502);
  const segmentMap = new Map(chunk.segments.map((segment) => [segment.segmentId, segment]));
  const items = rawItems.map((item, index) => {
    const segmentIds = normalizeKnowledgeReferenceIds(item?.segmentIds, chunk);
    if (!segmentIds.length) throw new AppError("KNOWLEDGE_ITEM_WITHOUT_EVIDENCE", `资料分块 ${chunk.id} 第 ${index + 1} 条没有字幕证据。`, {}, 502);
    const title = safeString(item?.title || item?.statement);
    const statement = safeString(item?.statement);
    if (!title || !statement) throw new AppError("KNOWLEDGE_ITEM_CONTENT_MISSING", `资料分块 ${chunk.id} 第 ${index + 1} 条缺少标题或可独立理解的结论。`, {}, 502);
    const type = safeString(item?.type);
    if (!allowedTypes.has(type)) throw new AppError("KNOWLEDGE_ITEM_TYPE_INVALID", `资料分块 ${chunk.id} 返回了不支持的知识类型。`, { type }, 502);
    const evidenceSegments = segmentIds.map((segmentId) => segmentMap.get(segmentId));
    const speakerIds = [...new Set(evidenceSegments.map((segment) => safeString(segment?.speakerId)).filter(Boolean))];
    const claimedSpeakerId = safeString(item?.speakerId);
    if (claimedSpeakerId && !speakerIds.includes(claimedSpeakerId)) {
      throw new AppError("KNOWLEDGE_SPEAKER_MISMATCH", `资料分块 ${chunk.id} 的说话人归属与字幕证据不符。`, { claimedSpeakerId, speakerIds }, 502);
    }
    return {
      id: safeString(item?.id) || `${chunk.id}-item-${index + 1}`,
      type,
      title,
      statement,
      explanation: safeString(item?.explanation),
      speakerId: speakerIds.length === 1 ? speakerIds[0] : "",
      speakerLabel: speakerIds.length === 1 ? safeString(evidenceSegments.find((segment) => segment?.speakerId === speakerIds[0])?.speakerLabel) : "",
      segmentIds,
      concepts: [...new Set((Array.isArray(item?.concepts) ? item.concepts : []).map(safeString).filter(Boolean))],
      needsExternalVerification: Boolean(item?.needsExternalVerification)
    };
  });
  const emptyReason = safeString(parsed?.emptyReason);
  if (!items.length && !emptyReason) throw new AppError("KNOWLEDGE_EMPTY_WITHOUT_REASON", `资料分块 ${chunk.id} 返回了空内容，但没有说明原因。`, {}, 502);
  const concepts = (Array.isArray(parsed?.concepts) ? parsed.concepts : []).map((concept) => ({
    label: safeString(concept?.label),
    definition: safeString(concept?.definition),
    segmentIds: normalizeKnowledgeReferenceIds(concept?.segmentIds, chunk, "concept.segmentIds")
  })).filter((concept) => concept.label && concept.segmentIds.length);
  return {
    coverage: { chunkId: chunk.id, firstSegmentId: chunk.firstSegmentId, lastSegmentId: chunk.lastSegmentId, segmentCount: chunk.segmentCount, omissionsChecked: true },
    items,
    concepts,
    emptyReason
  };
}

function assertAiMessageBudget(message, operation, phase = "chunk") {
  const chars = String(message || "").length;
  const maxChars = operation === "polish" && phase === "chunk" ? POLISH_SINGLE_CALL_MAX_CHARS : AI_CHUNK_MAX_CHARS;
  if (chars > maxChars) {
    throw new AppError("AI_INPUT_TOO_LONG", `${operation === "outline" ? "文字大纲" : operation === "mindmap" ? "思维导图" : "AI 处理"}分块输入超过安全长度预算，已停止发送。`, {
      operation,
      phase,
      inputChars: chars,
      maxChars,
      singleCallPreserved: operation === "polish",
      retryable: false
    }, 422);
  }
  return { inputChars: chars, inputTokens: estimateTokenCount(message) };
}

function buildChunkAnalysisMessage(operation, chunk, note) {
  if (operation === "polish") {
    const message = JSON.stringify({
      instruction: "separator 分隔已经建立好的连续编辑块。逐块做忠实逐字稿润色，返回相同数量的正文块；不得摘要、合并或省略。",
      video: { title: safeString(note?.title), provider: sourceProvider(note), sourceId: sourceId(note), bvid: safeString(note?.source?.bvid) },
      source: {
        key: chunk.sourceKey,
        segmentCount: chunk.segmentCount,
        blockCount: chunk.blockCount,
        inputChars: chunk.segments.reduce((sum, segment) => sum + segment.text.length, 0),
        separator: chunk.delimiter,
        transcript: chunk.transcript
      }
    });
    assertAiMessageBudget(message, operation, "chunk");
    return message;
  }
  const segments = chunk.segments.map(aiSegmentPayload);
  const message = JSON.stringify({
    instruction: operation === "polish"
      ? "数组每项为 [segmentIndex, 原文]；逐条润色并用 i/t/b 紧凑格式返回"
      : "逐条处理以下完整字幕片段",
    video: { title: safeString(note?.title), provider: sourceProvider(note), sourceId: sourceId(note), bvid: safeString(note?.source?.bvid) },
    chunk: {
      id: chunk.id,
      index: chunk.index,
      sourceKey: chunk.sourceKey,
      segments
    }
  });
  assertAiMessageBudget(message, operation, "chunk");
  return message;
}

function normalizeReferenceIds(node, segments) {
  const allowed = new Map(segments.map((segment) => [segment.segmentId, segment.segmentId]));
  const byIndex = segments.map((segment) => segment.segmentId);
  const rawIds = Array.isArray(node?.segmentIds) ? node.segmentIds : [];
  const rawIndexes = Array.isArray(node?.segmentIndexes) ? node.segmentIndexes : [];
  const ids = [
    ...rawIds.map((value) => safeString(value)),
    ...rawIndexes.map((value) => Number.isInteger(Number(value)) ? byIndex[Number(value)] : "")
  ];
  return [...new Set(ids.map((value) => allowed.get(value)).filter(Boolean))].slice(0, 8);
}

function normalizeChapterCandidate(node, segments, index, depth = 0) {
  const source = node && typeof node === "object" ? node : {};
  const segmentIds = normalizeReferenceIds(source, segments);
  const children = depth < 1 && Array.isArray(source.children)
    ? source.children.slice(0, 3).map((child, childIndex) => normalizeChapterCandidate(child, segments, childIndex, depth + 1)).filter(Boolean)
    : [];
  const title = outlineExcerptText(source.title || source.label || `章节 ${index + 1}`, depth === 0 ? 46 : 38);
  const summary = outlineExcerptText(source.summary || source.description, 120);
  const keyPoints = Array.isArray(source.keyPoints)
    ? source.keyPoints.map((point) => outlineExcerptText(point, 70)).filter(Boolean).slice(0, 3)
    : [];
  if (!title) return null;
  return {
    id: safeString(source.id) || `chapter-${depth + 1}-${index + 1}`,
    title,
    summary,
    keyPoints,
    segmentIds,
    children
  };
}

function normalizeConceptCandidate(node, segments, index, depth = 0) {
  const source = node && typeof node === "object" ? node : {};
  const label = outlineExcerptText(source.label || source.title || `概念 ${index + 1}`, 54);
  if (!label) return null;
  const children = depth < 2 && Array.isArray(source.children)
    ? source.children.slice(0, 3).map((child, childIndex) => normalizeConceptCandidate(child, segments, childIndex, depth + 1)).filter(Boolean)
    : [];
  return {
    id: safeString(source.id) || `concept-${depth + 1}-${index + 1}`,
    label,
    summary: outlineExcerptText(source.summary || source.description, 140),
    relation: outlineExcerptText(source.relation, 30),
    keywords: Array.isArray(source.keywords) ? source.keywords.map((item) => outlineExcerptText(item, 30)).filter(Boolean).slice(0, 5) : [],
    segmentIds: normalizeReferenceIds(source, segments),
    children
  };
}

function normalizeChunkOutlineResponse(parsed, chunk) {
  const raw = parsed?.chapters || parsed?.items || parsed?.children;
  if (!Array.isArray(raw)) throw new AppError("AI_INVALID_STRUCTURE_JSON", "文字大纲分块返回缺少 chapters 数组。", { chunkId: chunk.id }, 502);
  const chapters = raw.slice(0, 6).map((node, index) => normalizeChapterCandidate(node, chunk.segments, index)).filter(Boolean);
  if (!chapters.length) throw new AppError("AI_EMPTY_STRUCTURE", "文字大纲分块没有返回可用章节。", { chunkId: chunk.id }, 502);
  return { chapters };
}

function normalizeChunkMindmapResponse(parsed, chunk) {
  const raw = parsed?.concepts || parsed?.items || parsed?.children;
  if (!Array.isArray(raw)) throw new AppError("AI_INVALID_STRUCTURE_JSON", "思维导图分块返回缺少 concepts 数组。", { chunkId: chunk.id }, 502);
  const concepts = raw.slice(0, 8).map((node, index) => normalizeConceptCandidate(node, chunk.segments, index)).filter(Boolean);
  if (!concepts.length) throw new AppError("AI_EMPTY_STRUCTURE", "思维导图分块没有返回可用概念。", { chunkId: chunk.id }, 502);
  return { concepts };
}

function buildGlobalStructureMessage(operation, input, chunkResults, note) {
  const summaries = compactGlobalCandidates(operation, chunkResults);
  const payload = {
    instruction: operation === "outline"
      ? "根据完整分块章节候选和有限的全片抽样，合并出按论述顺序的文字大纲。boundedSample 只用于补充全片顺序，不是完整原文。"
      : "根据分块概念候选合并出全局思维导图；不要重新接收或猜测原文。",
    video: { title: safeString(note?.title), provider: sourceProvider(note), sourceId: sourceId(note), bvid: safeString(note?.source?.bvid) },
    scope: input.scope,
    chunks: summaries
  };
  if (operation === "outline") {
    const lines = buildOutlineTranscript(input).text.split("\n");
    const maxLines = Math.max(1, Math.floor(2200 / 72));
    const stride = Math.max(1, Math.ceil(lines.length / maxLines));
    const selected = lines.filter((line, index) => index === 0 || index === lines.length - 1 || index % stride === 0).slice(0, maxLines);
    payload.boundedSample = selected.join("\n");
  }
  const message = JSON.stringify(payload);
  assertAiMessageBudget(message, operation, "global");
  return message;
}

function dedupeNodes(nodes, keyField, maxCount) {
  const output = [];
  const seen = new Set();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const key = safeString(node?.[keyField]).toLowerCase().replace(/\s+/g, " ");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(node);
    if (output.length >= maxCount) break;
  }
  return output;
}

function sanitizeOutlineTree(tree, inputSegments) {
  const source = tree && typeof tree === "object" && !Array.isArray(tree) ? tree : {};
  const allowedSegments = inputSegments.map(normalizeAnalysisSegment);
  const normalize = (node, index, depth) => {
    const output = normalizeChapterCandidate(node, allowedSegments, index, depth);
    if (!output) return null;
    output.children = depth < 1
      ? dedupeNodes(output.children, "title", 3)
      : [];
    return output;
  };
  const rawItems = Array.isArray(source.items) ? source.items : Array.isArray(source.children) ? source.children : [];
  const items = dedupeNodes(rawItems.map((node, index) => normalize(node, index, 0)).filter(Boolean), "title", AI_MAX_OUTLINE_NODES);
  if (!items.length) throw new AppError("AI_EMPTY_STRUCTURE", "文字大纲合并后没有可用节点。", {}, 502);
  return {
    title: outlineExcerptText(source.title || source.label || "视频内容大纲", 60),
    summary: outlineExcerptText(source.summary || source.description, 180),
    items
  };
}

function sanitizeMindmapTree(tree, inputSegments) {
  const source = tree && typeof tree === "object" && !Array.isArray(tree) ? tree : {};
  const allowedSegments = inputSegments.map(normalizeAnalysisSegment);
  const normalize = (node, index, depth) => normalizeConceptCandidate(node, allowedSegments, index, depth);
  const rawChildren = Array.isArray(source.children) ? source.children : Array.isArray(source.items) ? source.items : [];
  const root = {
    id: safeString(source.id) || "root",
    label: outlineExcerptText(source.label || source.title || "视频主题", 60),
    summary: outlineExcerptText(source.summary || source.description, 180),
    relation: outlineExcerptText(source.relation, 30),
    keywords: Array.isArray(source.keywords) ? source.keywords.map((item) => outlineExcerptText(item, 30)).filter(Boolean).slice(0, 5) : [],
    segmentIds: normalizeReferenceIds(source, allowedSegments),
    children: dedupeNodes(rawChildren.map((node, index) => normalize(node, index, 0)).filter(Boolean), "label", AI_MAX_MINDMAP_NODES)
  };
  if (!root.label || !root.children.length) throw new AppError("AI_EMPTY_STRUCTURE", "思维导图合并后没有可用分支。", {}, 502);
  return root;
}

function fallbackOutlineTree(chunkResults, inputSegments, note) {
  const items = chunkResults.flatMap((item) => item.output?.chapters || []);
  return sanitizeOutlineTree({
    title: note?.title || "视频内容大纲",
    summary: "模型分块结果的部分合并，待重试失败分块后补全。",
    items
  }, inputSegments);
}

function fallbackMindmapTree(chunkResults, inputSegments, note) {
  const concepts = chunkResults.flatMap((item) => item.output?.concepts || []);
  return sanitizeMindmapTree({
    id: "root",
    label: note?.title || "视频主题",
    summary: "模型分块结果的部分合并，待重试失败分块后补全。",
    children: concepts
  }, inputSegments);
}

function countTextMatches(text, pattern) {
  return (safeString(text).match(pattern) || []).length;
}

function longestUnpunctuatedCjkRun(text) {
  return safeString(text)
    .split(/[，。！？；：、,.!?;:\n]/u)
    .reduce((longest, part) => Math.max(longest, countTextMatches(part, /[\u3400-\u9fff]/gu)), 0);
}

function assessPolishQuality(originalSegments, polishedSegments) {
  const originals = Array.isArray(originalSegments) ? originalSegments : [];
  const polished = Array.isArray(polishedSegments) ? polishedSegments : [];
  const originalText = originals.map((segment) => safeString(segment.text || segment.content)).join("");
  const polishedText = polished.map((segment) => safeString(segment.text || segment.content)).join("");
  const cjkChars = countTextMatches(polishedText, /[\u3400-\u9fff]/gu);
  const punctuationCount = countTextMatches(polishedText, /[，。！？；：、,.!?;:]/gu);
  const terminalPunctuationCount = countTextMatches(polishedText, /[。！？!?]/gu);
  const originalCjkChars = countTextMatches(originalText, /[\u3400-\u9fff]/gu);
  const originalPunctuationCount = countTextMatches(originalText, /[，。！？；：、,.!?;:]/gu);
  const identicalSegmentCount = originals.reduce((sum, original, index) => (
    safeString(original.text || original.content) === safeString(polished[index]?.text || polished[index]?.content) ? sum + 1 : sum
  ), 0);
  const identicalRatio = originals.length ? identicalSegmentCount / originals.length : 0;
  const punctuationPer100Cjk = cjkChars ? (punctuationCount / cjkChars) * 100 : 0;
  const originalPunctuationPer100Cjk = originalCjkChars ? (originalPunctuationCount / originalCjkChars) * 100 : 0;
  const maxUnpunctuatedCjkRun = longestUnpunctuatedCjkRun(polishedText);
  const paragraphBreakCount = polished.filter((segment) => segment.paragraphBreak === true).length;
  const lengthRatio = originalText.length ? polishedText.length / originalText.length : 1;
  const violations = [];
  if (cjkChars >= 80 && punctuationPer100Cjk < POLISH_MIN_PUNCTUATION_PER_100_CJK) {
    violations.push(`标点密度过低（每百个汉字 ${punctuationPer100Cjk.toFixed(1)} 个）`);
  }
  if (cjkChars >= 80 && terminalPunctuationCount < Math.max(1, Math.floor(cjkChars / 240))) {
    violations.push(`完整句子标记过少（仅 ${terminalPunctuationCount} 个句末标点）`);
  }
  if (maxUnpunctuatedCjkRun > POLISH_MAX_UNPUNCTUATED_CJK_RUN) {
    violations.push(`存在连续 ${maxUnpunctuatedCjkRun} 个汉字没有标点`);
  }
  if (originalPunctuationPer100Cjk < 1 && identicalRatio > POLISH_MAX_IDENTICAL_RATIO_FOR_RAW_INPUT) {
    violations.push(`与无标点原文完全相同的片段过多（${Math.round(identicalRatio * 100)}%）`);
  }
  if (originalCjkChars >= 200 && paragraphBreakCount < Math.max(1, Math.floor(originalCjkChars / 450))) {
    violations.push(`真实段落边界过少（仅 ${paragraphBreakCount} 个）`);
  }
  if (lengthRatio < 0.75) violations.push(`输出仅为原文长度的 ${Math.round(lengthRatio * 100)}%，可能过度删减`);
  if (lengthRatio > 1.3) violations.push(`输出达到原文长度的 ${Math.round(lengthRatio * 100)}%，可能加入了额外内容`);
  return {
    status: violations.length ? "failed" : "passed",
    passed: violations.length === 0,
    checkedAt: now(),
    segmentCount: polished.length,
    cjkChars,
    punctuationCount,
    terminalPunctuationCount,
    punctuationPer100Cjk: Number(punctuationPer100Cjk.toFixed(2)),
    maxUnpunctuatedCjkRun,
    identicalSegmentCount,
    identicalRatio: Number(identicalRatio.toFixed(4)),
    paragraphBreakCount,
    lengthRatio: Number(lengthRatio.toFixed(4)),
    violations
  };
}

function normalizePolishParagraphs(parsed, inputSegments) {
  const output = Array.isArray(parsed?.paragraphs) ? parsed.paragraphs : [];
  if (!output.length) throw new AppError("AI_EMPTY_POLISH_RESULT", "AI 没有返回任何润色段落。", {}, 502);
  const originals = inputSegments.map(normalizeAnalysisSegment);
  const paragraphs = [];
  let expectedStart = 0;
  output.forEach((item, outputIndex) => {
    if (!item || typeof item !== "object") {
      throw new AppError("AI_INVALID_POLISH_PARAGRAPH", `AI 第 ${outputIndex + 1} 个段落不是对象。`, { outputIndex }, 502);
    }
    const start = Number(item.s ?? item.start);
    const end = Number(item.e ?? item.end);
    const text = safeString(item.t ?? item.text);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start !== expectedStart || end < start || end >= originals.length) {
      throw new AppError("AI_INVALID_POLISH_COVERAGE", `AI 第 ${outputIndex + 1} 个段落的原文覆盖范围不连续。`, {
        outputIndex,
        expectedStart,
        actualStart: start,
        actualEnd: end,
        segmentCount: originals.length
      }, 502);
    }
    if (!text) throw new AppError("AI_EMPTY_POLISH_PARAGRAPH", `AI 第 ${outputIndex + 1} 个段落没有正文。`, { outputIndex }, 502);
    const covered = originals.slice(start, end + 1);
    const coveredOriginalText = covered.map((segment) => segment.text).join("");
    const coveredCount = end - start + 1;
    const localLengthRatio = coveredOriginalText.length ? text.length / coveredOriginalText.length : 1;
    if (coveredCount > 35 && coveredOriginalText.length > 180) {
      throw new AppError("AI_POLISH_PARAGRAPH_TOO_BROAD", `AI 第 ${outputIndex + 1} 个段落一次覆盖了 ${coveredCount} 条字幕，像摘要而不是逐字稿。`, {
        outputIndex, start, end, coveredCount, coveredOriginalChars: coveredOriginalText.length
      }, 502);
    }
    if (coveredOriginalText.length >= 80 && localLengthRatio < 0.65) {
      throw new AppError("AI_POLISH_PARAGRAPH_OVERCOMPRESSED", `AI 第 ${outputIndex + 1} 个段落只保留了所覆盖原文的 ${Math.round(localLengthRatio * 100)}%。`, {
        outputIndex, start, end, coveredOriginalChars: coveredOriginalText.length, outputChars: text.length, localLengthRatio
      }, 502);
    }
    if (coveredOriginalText.length >= 80 && localLengthRatio > 1.35) {
      throw new AppError("AI_POLISH_PARAGRAPH_EXPANDED", `AI 第 ${outputIndex + 1} 个段落达到所覆盖原文的 ${Math.round(localLengthRatio * 100)}%，可能加入了额外内容。`, {
        outputIndex, start, end, coveredOriginalChars: coveredOriginalText.length, outputChars: text.length, localLengthRatio
      }, 502);
    }
    const first = covered[0];
    const last = covered[covered.length - 1];
    const sourceSegmentIds = covered.map((segment) => segment.segmentId);
    const stable = crypto.createHash("sha1").update(`${first.sourceKey}|${sourceSegmentIds.join("|")}`).digest("hex").slice(0, 12);
    paragraphs.push({
      ...first,
      id: `paragraph-${stable}`,
      segmentId: `paragraph-${stable}`,
      from: first.from,
      to: last.to,
      text,
      content: text,
      originalText: coveredOriginalText,
      sourceLengthRatio: Number(localLengthRatio.toFixed(4)),
      sourceSegmentIds,
      sourceStartIndex: start,
      sourceEndIndex: end,
      paragraphBreak: true
    });
    expectedStart = end + 1;
  });
  if (expectedStart !== originals.length) {
    throw new AppError("AI_INCOMPLETE_POLISH_COVERAGE", `AI 只覆盖了 ${expectedStart}/${originals.length} 条原字幕，已拒绝保存。`, {
      coveredSegmentCount: expectedStart,
      segmentCount: originals.length
    }, 502);
  }
  const quality = assessPolishQuality(originals, paragraphs);
  if (!quality.passed) {
    throw new AppError("AI_POLISH_QUALITY_FAILED", `AI 润色质量未通过：${quality.violations.join("；")}`, { quality }, 502);
  }
  return paragraphs;
}

function splitPolishTextByWeights(text, weights) {
  if (weights.length <= 1) return [safeString(text).trim()];
  const value = safeString(text).trim();
  const sentenceBoundaries = [];
  for (const match of value.matchAll(/[。！？!?；;]\s*/gu)) sentenceBoundaries.push(match.index + match[0].length);
  const fallbackBoundaries = [];
  for (const match of value.matchAll(/[，、：,:]\s*/gu)) fallbackBoundaries.push(match.index + match[0].length);
  const boundaries = [...new Set([...sentenceBoundaries, ...fallbackBoundaries])].sort((a, b) => a - b);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const pieces = [];
  let start = 0;
  let usedWeight = 0;
  for (let index = 0; index < weights.length - 1; index += 1) {
    usedWeight += weights[index];
    const target = Math.round(value.length * (usedWeight / Math.max(1, totalWeight)));
    const remainingPieces = weights.length - index - 1;
    const minPieceChars = 24;
    const candidates = boundaries.filter((position) => (
      position > start + minPieceChars
      && position < value.length - remainingPieces * minPieceChars
    ));
    const cut = candidates.length
      ? candidates.reduce((best, position) => Math.abs(position - target) < Math.abs(best - target) ? position : best, candidates[0])
      : Math.max(start + minPieceChars, Math.min(value.length - remainingPieces * minPieceChars, target));
    pieces.push(value.slice(start, cut).trim());
    start = cut;
  }
  pieces.push(value.slice(start).trim());
  return pieces;
}

function recoverMergedPolishBlocks(returnedOutputs, blocks) {
  const outputCount = returnedOutputs.length;
  const blockCount = blocks.length;
  const dp = Array.from({ length: outputCount + 1 }, () => Array(blockCount + 1).fill(null));
  dp[0][0] = { cost: 0, groups: [] };
  for (let outputIndex = 1; outputIndex <= outputCount; outputIndex += 1) {
    const minBlockEnd = outputIndex;
    const maxBlockEnd = blockCount - (outputCount - outputIndex);
    for (let blockEnd = minBlockEnd; blockEnd <= maxBlockEnd; blockEnd += 1) {
      for (let previousEnd = outputIndex - 1; previousEnd < blockEnd; previousEnd += 1) {
        const previous = dp[outputIndex - 1][previousEnd];
        if (!previous) continue;
        const originalChars = blocks.slice(previousEnd, blockEnd).reduce((sum, block) => sum + block.text.length, 0);
        const ratio = originalChars ? returnedOutputs[outputIndex - 1].length / originalChars : 1;
        if (ratio < 0.6 || ratio > 1.55) continue;
        const cost = previous.cost + Math.abs(Math.log(ratio));
        if (!dp[outputIndex][blockEnd] || cost < dp[outputIndex][blockEnd].cost) {
          dp[outputIndex][blockEnd] = {
            cost,
            groups: [...previous.groups, { start: previousEnd, end: blockEnd }]
          };
        }
      }
    }
  }
  const recovered = dp[outputCount][blockCount];
  if (!recovered) {
    throw new AppError("AI_POLISH_BLOCK_COUNT_MISMATCH", `AI 合并了润色块，但本地无法安全恢复 ${blockCount} 个连续边界。`, {
      expectedBlockCount: blockCount,
      actualBlockCount: outputCount,
      recoveryFailed: true
    }, 502);
  }
  return recovered.groups.flatMap((group, outputIndex) => {
    const groupBlocks = blocks.slice(group.start, group.end);
    return splitPolishTextByWeights(returnedOutputs[outputIndex], groupBlocks.map((block) => block.text.length));
  });
}

function normalizePolishBlockText(rawText, chunk) {
  let value = safeString(rawText).replace(/^```(?:text|markdown)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!value) throw new AppError("AI_EMPTY_POLISH_RESULT", "AI 没有返回任何润色正文。", {}, 502);
  const blocks = Array.isArray(chunk?.blocks) ? chunk.blocks : [];
  if (!blocks.length || !safeString(chunk?.delimiter)) {
    throw new AppError("AI_POLISH_BLOCK_PLAN_MISSING", "本地润色编辑块计划缺失，已停止保存。", {}, 500);
  }
  const returnedOutputs = value.split(chunk.delimiter).map((text) => text.trim()).filter(Boolean);
  if (!returnedOutputs.length || returnedOutputs.length > blocks.length) {
    throw new AppError("AI_POLISH_BLOCK_COUNT_MISMATCH", `AI 应返回不超过 ${blocks.length} 个润色块，实际返回 ${returnedOutputs.length} 个。`, {
      expectedBlockCount: blocks.length,
      actualBlockCount: returnedOutputs.length
    }, 502);
  }
  const outputs = returnedOutputs.length === blocks.length
    ? returnedOutputs
    : recoverMergedPolishBlocks(returnedOutputs, blocks);
  const paragraphs = blocks.map((block, index) => {
    const text = outputs[index];
    const originalText = block.text;
    const localLengthRatio = originalText.length ? text.length / originalText.length : 1;
    if (originalText.length >= 80 && localLengthRatio < 0.65) {
      throw new AppError("AI_POLISH_BLOCK_OVERCOMPRESSED", `AI 第 ${index + 1} 个编辑块只保留了原文的 ${Math.round(localLengthRatio * 100)}%。`, {
        blockIndex: index,
        originalChars: originalText.length,
        outputChars: text.length,
        localLengthRatio
      }, 502);
    }
    // 短口语块补上标点、引号、中英文空格和必要的断句后，个别块可能明显变长。
    // 单块允许到 150%，但下方全调用质量门禁仍限制总输出不超过原文 130%，避免整体注水。
    if (originalText.length >= 80 && localLengthRatio > 1.5) {
      throw new AppError("AI_POLISH_BLOCK_EXPANDED", `AI 第 ${index + 1} 个编辑块达到原文的 ${Math.round(localLengthRatio * 100)}%，可能加入了额外内容。`, {
        blockIndex: index,
        originalChars: originalText.length,
        outputChars: text.length,
        localLengthRatio
      }, 502);
    }
    const first = block.segments[0];
    const last = block.segments[block.segments.length - 1];
    const stable = crypto.createHash("sha1").update(`${first.sourceKey}|${block.sourceSegmentIds.join("|")}`).digest("hex").slice(0, 12);
    return {
      ...first,
      id: `paragraph-${stable}`,
      segmentId: `paragraph-${stable}`,
      from: first.from,
      to: last.to,
      text,
      content: text,
      originalText,
      sourceSegmentIds: [...block.sourceSegmentIds],
      sourceBlockIndex: index,
      sourceLengthRatio: Number(localLengthRatio.toFixed(4)),
      paragraphBreak: true,
      recoveredMergedBoundary: returnedOutputs.length !== blocks.length
    };
  });
  const quality = assessPolishQuality(chunk.segments, paragraphs);
  if (!quality.passed) {
    throw new AppError("AI_POLISH_QUALITY_FAILED", `AI 润色质量未通过：${quality.violations.join("；")}`, { quality }, 502);
  }
  return paragraphs;
}

function normalizeAlignedSegments(parsed, inputSegments, operation = "") {
  const output = Array.isArray(parsed?.segments) ? parsed.segments : [];
  if (!output.length) throw new AppError("AI_EMPTY_ALIGNED_RESULT", "AI 没有返回任何对齐字幕片段。", {}, 502);
  const originals = inputSegments.map(normalizeAnalysisSegment);
  const byId = new Map(originals.map((segment) => [segment.segmentId, segment]));
  const byIndex = new Map(originals.map((segment, index) => [index, segment]));
  const seen = new Set();
  const replacements = new Map();
  output.forEach((item, outputIndex) => {
    if (!item || typeof item !== "object") throw new AppError("AI_INVALID_ALIGNMENT", `AI 第 ${outputIndex + 1} 条结果不是对象。`, { outputIndex }, 502);
    const idValue = safeString(item.segmentId ?? item.id);
    const indexValue = item.segmentIndex ?? item.index ?? item.i;
    const original = idValue ? byId.get(idValue) : byIndex.get(Number(indexValue));
    if (!original) throw new AppError("AI_INVALID_SEGMENT_ID", `AI 返回了不存在的字幕片段引用：${idValue || indexValue}。`, { outputIndex, segmentId: idValue }, 502);
    if (seen.has(original.segmentId)) throw new AppError("AI_DUPLICATE_SEGMENT", `AI 重复返回了字幕片段 ${original.segmentId}。`, { segmentId: original.segmentId }, 502);
    const text = safeString(item.text ?? item.t);
    if (!text) throw new AppError("AI_EMPTY_SEGMENT_RESULT", `AI 没有返回字幕片段 ${original.segmentId} 的文字。`, { segmentId: original.segmentId }, 502);
    seen.add(original.segmentId);
    const paragraphBreak = item.paragraphBreak ?? item.b;
    if (operation === "polish" && typeof paragraphBreak !== "boolean") {
      throw new AppError("AI_POLISH_PARAGRAPH_MARKER_MISSING", `AI 没有为字幕片段 ${original.segmentId} 返回段落边界。`, { segmentId: original.segmentId }, 502);
    }
    replacements.set(original.segmentId, { text, paragraphBreak: Boolean(paragraphBreak) });
  });
  const missing = originals.filter((segment) => !seen.has(segment.segmentId)).map((segment) => segment.segmentId);
  if (missing.length) {
    throw new AppError("AI_MISSING_SEGMENTS", `AI 少返回了 ${missing.length} 个字幕片段，已拒绝合并以避免错位。`, {
      missingSegmentIds: missing.slice(0, 20),
      missingCount: missing.length
    }, 502);
  }
  const normalized = originals.map((original) => ({
    ...original,
    id: original.segmentId,
    text: replacements.get(original.segmentId).text,
    content: replacements.get(original.segmentId).text,
    paragraphBreak: replacements.get(original.segmentId).paragraphBreak
  }));
  if (operation === "polish") {
    const quality = assessPolishQuality(originals, normalized);
    if (!quality.passed) {
      throw new AppError("AI_POLISH_QUALITY_FAILED", `AI 润色质量未通过：${quality.violations.join("；")}`, { quality }, 502);
    }
  }
  return normalized;
}

function compactOutlineTree(tree) {
  const source = tree && typeof tree === "object" && !Array.isArray(tree) ? tree : {};
  const rawItems = Array.isArray(source.items)
    ? source.items
    : Array.isArray(source.children)
      ? source.children
      : [];
  const compactNode = (node, index, depth) => {
    const item = node && typeof node === "object" ? node : {};
    const rawPoints = Array.isArray(item.keyPoints) ? item.keyPoints : [];
    const rawChildren = Array.isArray(item.children) ? item.children : [];
    const output = {
      id: safeString(item.id) || `outline-${depth + 1}-${index + 1}`,
      title: outlineExcerptText(item.title || item.label || `章节 ${index + 1}`, depth === 0 ? 16 : 14),
      summary: outlineExcerptText(item.summary || item.description, depth === 0 ? 32 : 28),
      keyPoints: rawPoints.map((point) => outlineExcerptText(point, 20)).filter(Boolean).slice(0, 1),
      segmentIndexes: (Array.isArray(item.segmentIndexes) ? item.segmentIndexes : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0)
        .slice(0, 2),
      children: []
    };
    if (Array.isArray(item.segmentIds)) {
      output.segmentIds = item.segmentIds.map((value) => safeString(value)).filter(Boolean).slice(0, 2);
    }
    // 短版大纲只保留一层子节点；子节点不再继续展开，避免再次变成长目录。
    if (depth === 0 && rawChildren.length) {
      output.children = [compactNode(rawChildren[0], 0, 1)];
    }
    return output;
  };

  const compact = {
    title: outlineExcerptText(source.title || source.label || "视频内容大纲", 24),
    summary: outlineExcerptText(source.summary || source.description, 45),
    items: rawItems.slice(0, 5).map((item, index) => compactNode(item, index, 0))
  };

  // 这是服务端兜底，不依赖模型是否完全听懂提示词。
  if (JSON.stringify(compact).length <= OUTLINE_RESULT_MAX_CHARS) return compact;
  compact.items.forEach((item) => {
    item.children = [];
    item.keyPoints = item.keyPoints.slice(0, 1);
    item.summary = item.summary.slice(0, 24);
  });
  compact.summary = compact.summary.slice(0, 32);
  return compact;
}

function normalizeStructureReferences(tree, inputSegments) {
  const idByIndex = new Map(inputSegments.map((segment, index) => [index, segment.id]));
  const normalizeNode = (node) => {
    if (Array.isArray(node)) return node.map(normalizeNode);
    if (!node || typeof node !== "object") return node;

    const output = { ...node };
    const existingIds = Array.isArray(node.segmentIds)
      ? node.segmentIds.map((value) => safeString(value)).filter(Boolean)
      : [];
    const indexValues = [];
    if (Array.isArray(node.segmentIndexes)) indexValues.push(...node.segmentIndexes);
    if (node.segmentIndex !== undefined && node.segmentIndex !== null) indexValues.push(node.segmentIndex);
    const mappedIds = indexValues
      .filter((value) => Number.isInteger(Number(value)))
      .map((value) => idByIndex.get(Number(value)))
      .filter(Boolean);
    const ids = [...new Set([...existingIds, ...mappedIds])];
    if (ids.length) output.segmentIds = ids;
    delete output.segmentIndexes;
    delete output.segmentIndex;
    if (Array.isArray(node.children)) output.children = node.children.map(normalizeNode);
    if (Array.isArray(node.items)) output.items = node.items.map(normalizeNode);
    return output;
  };
  return normalizeNode(tree);
}

function analysisTarget(note, operation) {
  if (operation === "polish") return note.transcript.polished;
  if (operation === "outline") return note.outline;
  if (operation === "mindmap") return note.mindmap;
  return null;
}

function analysisRequestFromBody(note, body) {
  const operation = safeString(body.operation);
  if (operation === "translate") {
    throw new AppError("TRANSLATION_REMOVED", "翻译功能已移除，请使用原文、AI润色版或说话人版。", { operation }, 410);
  }
  if (!["polish", "outline", "mindmap", "structure", "knowledge_extract"].includes(operation)) {
    throw new AppError("INVALID_ANALYSIS", "暂不支持这个 AI 处理类型。", {}, 400);
  }
  const pageIndex = Math.max(0, Number(body.pageIndex || 0));
  const trackIndex = Math.max(0, Number(body.trackIndex || 0));
  const pageScope = body.pageScope === "all" ? "all" : "current";
  const trackScope = body.trackScope === "all" ? "all" : "current";
  const rawInput = buildAnalysisInput(note, pageIndex, trackIndex, pageScope, trackScope);
  const transcriptMode = ["original", "speaker"].includes(body.transcriptMode) ? body.transcriptMode : "polished";
  const input = operation === "structure"
    ? buildPolishedStructureInput(note, rawInput)
    : operation === "knowledge_extract"
      ? buildKnowledgeInput(note, { pageIndex, trackIndex, pageScope, trackScope, transcriptMode })
      : rawInput;
  const engine = operation === "knowledge_extract" ? "api" : safeString(body.engine || note.settings?.processingEngine || "api");
  const requestedProvider = safeString(body.provider || note.settings?.provider);
  const provider = engine === "api" && ["codex", "gemini-cli"].includes(requestedProvider) ? "" : requestedProvider;
  const model = safeString(body.model || note.settings?.model);
  const chunks = operation === "knowledge_extract" ? createKnowledgeChunks(input.segments) : createAnalysisChunks(input.segments, operation);
  const inputChars = input.segments.reduce((sum, segment) => sum + String(segment.text || "").length, 0);
  const inputTokens = operation === "polish"
    ? chunks.reduce((sum, chunk) => sum + estimateMixedLanguageTokens(`${aiSystemPrompt(operation)}\n${buildChunkAnalysisMessage(operation, chunk, note)}`), 0)
    : operation === "knowledge_extract"
      ? chunks.reduce((sum, chunk) => sum + estimateMixedLanguageTokens(`${aiSystemPrompt("knowledge_chunk")}\n${buildKnowledgeChunkMessage(chunk, note)}`), 0)
    : estimateTokenCount(inputChars);
  const expectedOutputTokens = operation === "polish"
    ? estimateMixedLanguageTokens(input.segments.map((segment) => safeString(segment.text)).join(""))
    : 0;
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({
    operation,
    promptContractHash: sha256Json({
      systemPrompt: aiSystemPrompt(operation === "knowledge_extract" ? "knowledge_chunk" : operation),
      chunkContract: operation === "polish"
        ? "dynamic-1-to-5-fixed-edit-blocks-v7"
        : operation === "knowledge_extract"
          ? "compact-dynamic-1-to-5-local-source-coverage-v2"
          : "default-v1"
    }),
    engine,
    provider,
    model,
    transcriptMode,
    scope: input.scope,
    segments: input.segments.map((segment) => [stableSegmentKey(segment), safeString(segment.text)])
  })).digest("hex");
  return {
    operation,
    pageIndex,
    trackIndex,
    pageScope,
    trackScope,
    transcriptMode,
    engine,
    provider,
    model,
    input,
    chunks,
    inputChars,
    inputTokens,
    expectedOutputTokens,
    fingerprint
  };
}

function previewKnowledgeMaterials(note, body = {}) {
  const plan = analysisRequestFromBody(note, { ...body, operation: "knowledge_extract", engine: "api" });
  return {
    transcriptMode: plan.transcriptMode,
    sourceSegmentCount: Number(plan.input.sourceSegmentCount || plan.input.snapshotCore?.sourceSegmentCount || 0),
    knowledgeSegmentCount: plan.input.segments.length,
    chunkCount: plan.chunks.length,
    inputChars: plan.inputChars,
    inputTokens: plan.inputTokens,
    expectedOutputTokens: plan.expectedOutputTokens
  };
}

function taskCollections(task) {
  if (Array.isArray(task.chunks) && task.chunks.length) return [{ key: task.meta?.operation || "analysis", chunks: task.chunks }];
  return Object.entries(task.parts || {}).map(([key, part]) => ({ key, chunks: Array.isArray(part.chunks) ? part.chunks : [] }));
}

function refreshTaskMetrics(task) {
  const collections = taskCollections(task);
  const chunks = collections.flatMap((item) => item.chunks);
  const failed = chunks.filter((chunk) => chunk.status === "failed");
  const completed = chunks.filter((chunk) => chunk.status === "completed");
  task.metrics = {
    ...(task.metrics || {}),
    chunkCount: chunks.length,
    completedChunkCount: completed.length,
    failedChunkCount: failed.length,
    outputChars: chunks.reduce((sum, chunk) => sum + Number(chunk.outputChars || 0), 0),
    outputTokens: chunks.reduce((sum, chunk) => sum + Number(chunk.outputTokens || 0), 0),
    receivedOutputChars: chunks.reduce((sum, chunk) => sum + Number(chunk.receivedOutputChars || chunk.outputChars || 0), 0),
    receivedOutputTokens: chunks.reduce((sum, chunk) => sum + Number(chunk.receivedOutputTokens || chunk.outputTokens || 0), 0),
    failedChunkIds: failed.map((chunk) => chunk.id),
    inputChars: Number(task.metrics?.inputChars || task.meta?.inputChars || 0),
    inputTokens: Number(task.metrics?.inputTokens || task.meta?.inputTokens || 0)
  };
  return task.metrics;
}

function analysisTaskMeta(plan) {
  return {
    operation: plan.operation,
    engine: plan.engine,
    provider: plan.provider,
    model: plan.model,
    pageScope: plan.pageScope,
    trackScope: plan.trackScope,
    inputFingerprint: plan.fingerprint,
    sourceCount: plan.input.sources.length,
    segmentCount: plan.input.segments.length,
    chunkCount: plan.chunks.length,
    inputChars: plan.inputChars,
    inputTokens: plan.inputTokens
  };
}

function reusablePolishSegmentMap(noteId, provider, model) {
  const output = new Map();
  for (const task of listAnalysisTasks(noteId)) {
    if (task.meta?.operation !== "polish") continue;
    if (safeString(task.meta?.provider) !== safeString(provider) || safeString(task.meta?.model) !== safeString(model)) continue;
    for (const chunk of task.chunks || []) {
      if (chunk.status !== "completed" || chunk.output?.quality?.passed !== true) continue;
      for (const segment of chunk.output?.segments || []) {
        if (!safeString(segment.segmentId || segment.id) || typeof segment.paragraphBreak !== "boolean") continue;
        output.set(safeString(segment.segmentId || segment.id), {
          text: safeString(segment.text),
          paragraphBreak: segment.paragraphBreak
        });
      }
    }
  }
  return output;
}

function polishChunksWithReusableResults(noteId, plan) {
  const reusable = reusablePolishSegmentMap(noteId, plan.provider, plan.model);
  if (!reusable.size) return clone(plan.chunks);
  const runs = [];
  let current = null;
  for (const segment of plan.input.segments) {
    const isReusable = reusable.has(safeString(segment.id || segment.segmentId));
    if (!current || current.isReusable !== isReusable || current.sourceKey !== segment.sourceKey) {
      current = { isReusable, sourceKey: segment.sourceKey, segments: [] };
      runs.push(current);
    }
    current.segments.push(segment);
  }
  const chunks = [];
  for (const run of runs) {
    for (const chunk of createAnalysisChunks(run.segments, "polish")) {
      if (run.isReusable) {
        const normalized = chunk.segments.map((segment) => {
          const replacement = reusable.get(segment.segmentId);
          return { ...segment, text: replacement.text, content: replacement.text, paragraphBreak: replacement.paragraphBreak };
        });
        chunk.output = { segments: normalized, quality: assessPolishQuality(chunk.segments, normalized) };
        chunk.outputChars = normalized.reduce((sum, segment) => sum + segment.text.length, 0);
        chunk.outputTokens = estimateTokenCount(chunk.outputChars);
        chunk.model = plan.model;
        chunk.status = "completed";
        chunk.completedAt = now();
        chunk.error = null;
        chunk.reused = true;
      }
      chunks.push(chunk);
    }
  }
  chunks.forEach((chunk, index) => {
    const digest = crypto.createHash("sha1").update(`${chunk.sourceKey}:${chunk.segments[0].segmentId}`).digest("hex").slice(0, 10);
    chunk.index = index;
    chunk.id = `chunk-${String(index + 1).padStart(3, "0")}-${digest}`;
  });
  return chunks;
}

function createAnalysisTask(note, body, preparedPlan = null) {
  const plan = preparedPlan || analysisRequestFromBody(note, body);
  const task = createTask("analysis", note.id, analysisTaskMeta(plan));
  task.analysis = {
    request: {
      operation: plan.operation,
      pageIndex: plan.pageIndex,
      trackIndex: plan.trackIndex,
      pageScope: plan.pageScope,
      trackScope: plan.trackScope,
      transcriptMode: plan.transcriptMode,
      engine: plan.engine,
      provider: plan.provider,
      model: plan.model
    },
    input: clone(plan.input),
    baseChunks: clone(plan.chunks)
  };
  if (plan.operation === "structure") {
    task.parts = {
      outline: { status: "queued", globalStatus: "queued", chunks: clone(plan.chunks), output: null, error: null },
      mindmap: { status: "queued", globalStatus: "queued", chunks: clone(plan.chunks), output: null, error: null }
    };
  } else if (["outline", "mindmap"].includes(plan.operation)) {
    task.parts = {
      [plan.operation]: { status: "queued", globalStatus: "queued", chunks: clone(plan.chunks), output: null, error: null }
    };
  } else {
    task.chunks = clone(plan.chunks);
    task.analysis.baseChunks = clone(task.chunks);
    if (plan.operation === "polish") {
      task.meta.chunkCount = task.chunks.length;
      task.meta.reusedChunkCount = 0;
      task.meta.reusedSegmentCount = 0;
    }
  }
  refreshTaskMetrics(task);
  saveTask(task);
  return { task, plan };
}

function listAnalysisTasks(noteId) {
  return fs.readdirSync(TASKS_DIR)
    .filter((filename) => filename.endsWith(".json"))
    .map((filename) => readJsonFile(path.join(TASKS_DIR, filename), null))
    .filter((task) => task?.type === "analysis" && task.noteId === noteId)
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

function listNoteTasks(noteId) {
  return fs.readdirSync(TASKS_DIR)
    .filter((filename) => filename.endsWith(".json"))
    .map((filename) => readJsonFile(path.join(TASKS_DIR, filename), null))
    .filter((task) => task?.noteId === noteId && ["analysis", "asr", "diarization"].includes(task.type))
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

function findReusableAnalysisTask(noteId, fingerprint) {
  return listAnalysisTasks(noteId).find((task) => task.meta?.inputFingerprint === fingerprint && ["queued", "running", "completed"].includes(task.status));
}

function prepareAnalysisTaskRetry(task) {
  if (task.type !== "analysis") throw new AppError("TASK_NOT_RETRYABLE", "这不是可重试的 AI 任务。", {}, 409);
  if (task.meta?.operation === "translate") {
    throw new AppError("TRANSLATION_REMOVED", "翻译功能已移除，旧翻译任务不能重试。", { taskId: task.id }, 410);
  }
  if (!["failed", "interrupted"].includes(task.status)) throw new AppError("TASK_NOT_RETRYABLE", "只有失败或中断的任务可以重试。", { status: task.status }, 409);
  for (const { chunks } of taskCollections(task)) {
    for (const chunk of chunks) {
      if (chunk.status === "completed") continue;
      if (task.meta?.operation === "polish" && safeString(chunk.rawOutput)) {
        try {
          const normalized = normalizePolishBlockText(chunk.rawOutput, chunk);
          chunk.output = { segments: normalized, quality: assessPolishQuality(chunk.segments, normalized) };
          chunk.outputChars = normalized.reduce((sum, segment) => sum + safeString(segment.text).length, 0);
          chunk.outputTokens = estimateTokenCount(chunk.outputChars);
          chunk.receivedOutputChars = safeString(chunk.rawOutput).length;
          chunk.receivedOutputTokens = estimateTokenCount(chunk.receivedOutputChars);
          chunk.model = safeString(task.meta?.model);
          chunk.status = "completed";
          chunk.completedAt = now();
          chunk.recoveredFromPaidResponse = true;
          chunk.error = null;
          continue;
        } catch {
          // 原返回仍无法通过完整性和质量门禁时，才真正重试 API。
        }
      }
      chunk.status = "queued";
      chunk.error = null;
      delete chunk.startedAt;
      delete chunk.failedAt;
    }
  }
  for (const part of Object.values(task.parts || {})) {
    if (part.status === "completed" && part.output?.tree) continue;
    part.status = "queued";
    part.globalStatus = "queued";
    part.error = null;
  }
  task.status = "queued";
  task.progress = 0;
  task.message = "等待重试失败分块";
  task.error = null;
  task.result = null;
  task.retryCount = Number(task.retryCount || 0) + 1;
  task.lastRetriedAt = now();
  delete task.completedAt;
  refreshTaskMetrics(task);
  saveTask(task);
  appendGenerationEvent(task, "retried");
  appendOperationEvent(task.noteId, "ai_task_retried", {
    taskId: task.id,
    operation: task.meta?.operation,
    retryCount: task.retryCount,
    retainedCompletedChunkCount: task.metrics.completedChunkCount,
    retryChunkIds: taskCollections(task).flatMap((item) => item.chunks.filter((chunk) => chunk.status === "queued").map((chunk) => chunk.id))
  });
  return task;
}

function saveAlignmentPartial(note, task, input, plan) {
  const target = analysisTarget(note, plan.operation);
  if (!target) throw new AppError("INVALID_ANALYSIS", "AI 结果没有可保存的目标。", {}, 500);
  const completedChunks = task.chunks.filter((chunk) => chunk.status === "completed" && Array.isArray(chunk.output?.segments));
  if (!completedChunks.length) return;
  const originalOrder = new Map(input.segments.map((segment, index) => [segment.segmentId || segment.id, index]));
  const normalized = completedChunks.flatMap((chunk) => chunk.output.segments)
    .sort((a, b) => (originalOrder.get(a.segmentId || a.id) ?? 0) - (originalOrder.get(b.segmentId || b.id) ?? 0));
  const generatedAt = now();
  const variants = { ...(target.variants || {}) };
  const allParagraphs = [];
  for (const source of input.sources) {
    const sourceSegments = normalized.filter((segment) => segment.sourceKey === source.sourceKey);
    const paragraphs = plan.operation === "polish" ? mergePolishedParagraphSegments(sourceSegments) : [];
    allParagraphs.push(...paragraphs);
    variants[source.sourceKey] = {
      ...source,
      segments: sourceSegments,
      ...(plan.operation === "polish" ? { paragraphs } : {}),
      generatedAt,
      engine: plan.engine,
      provider: plan.provider,
      model: plan.model
    };
    if (plan.operation === "polish" && sourceSegments.length) {
      const originalSourceSegments = input.segments.filter((segment) => segment.sourceKey === source.sourceKey);
      variants[source.sourceKey].quality = assessPolishQuality(originalSourceSegments, sourceSegments);
    }
  }
  const allCompleted = task.chunks.length > 0 && task.chunks.every((chunk) => chunk.status === "completed");
  target.status = allCompleted ? "ready" : "partial";
  target.pageIndex = input.sources.length === 1 ? input.sources[0].pageIndex : -1;
  target.trackId = input.sources.length === 1 ? input.sources[0].trackId : "";
  target.segments = normalized;
  if (plan.operation === "polish") target.paragraphs = allParagraphs;
  target.variants = variants;
  target.scope = input.scope;
  target.generatedAt = generatedAt;
  target.engine = plan.engine;
  target.provider = plan.provider;
  target.model = plan.model;
  target.inputFingerprint = plan.fingerprint;
  target.chunkCount = task.chunks.length;
  target.completedChunkCount = completedChunks.length;
  target.failedChunkIds = task.chunks.filter((chunk) => chunk.status === "failed").map((chunk) => chunk.id);
  if (plan.operation === "polish" && allCompleted) target.quality = assessPolishQuality(input.segments, normalized);
  target.partialMessage = allCompleted ? "" : "部分分块已完成，可只重试失败分块。";
  if (plan.operation === "polish") invalidateKnowledge(note, "AI 润色版已更新");
  note.settings = { ...(note.settings || {}), provider: plan.provider, model: plan.model };
  note.processing.ai = allCompleted ? "ready" : "partial";
  note.status = "ready";
  saveNote(note);
}

function knowledgeMaterialFromTask(note, task, plan) {
  const chunks = task.chunks.map((chunk) => ({
    id: chunk.id,
    index: chunk.index,
    sourceKeys: chunk.sourceKeys,
    segmentIds: chunk.segmentIds,
    firstSegmentId: chunk.firstSegmentId,
    lastSegmentId: chunk.lastSegmentId,
    segmentCount: chunk.segmentCount,
    inputHash: chunk.inputHash,
    status: chunk.status,
    attempts: chunk.attempts,
    completedAt: chunk.completedAt || "",
    error: chunk.error || null,
    output: chunk.output || null
  }));
  const completed = chunks.filter((chunk) => chunk.status === "completed");
  const failed = chunks.filter((chunk) => chunk.status === "failed");
  const expectedIds = plan.input.segments.map((segment) => segment.segmentId);
  const sourceIdsByKnowledgeSegment = new Map(plan.input.segments.map((segment) => [
    segment.segmentId,
    (segment.sourceSegmentIds || [segment.segmentId]).map((sourceSegmentId) => `${segment.sourceKey}::${sourceSegmentId}`)
  ]));
  const expectedSourceIds = [...new Set(plan.input.segments.flatMap((segment) => sourceIdsByKnowledgeSegment.get(segment.segmentId) || []))];
  const coveredIds = chunks.flatMap((chunk) => chunk.segmentIds || []);
  const counts = new Map();
  coveredIds.forEach((segmentId) => counts.set(segmentId, Number(counts.get(segmentId) || 0) + 1));
  const missingIds = expectedIds.filter((segmentId) => !counts.has(segmentId));
  const duplicateIds = [...counts.entries()].filter(([, count]) => count !== 1).map(([segmentId]) => segmentId);
  const completedKnowledgeIds = completed.flatMap((chunk) => chunk.segmentIds || []);
  const completedSourceIds = [...new Set(completedKnowledgeIds.flatMap((segmentId) => sourceIdsByKnowledgeSegment.get(segmentId) || []))];
  const completedSourceIdSet = new Set(completedSourceIds);
  const missingSourceIds = expectedSourceIds.filter((sourceSegmentId) => !completedSourceIdSet.has(sourceSegmentId));
  const invalidOutputs = completed.filter((chunk) => !chunk.output?.coverage?.omissionsChecked || safeString(chunk.output.coverage.chunkId) !== chunk.id).map((chunk) => chunk.id);
  const ready = chunks.length > 0
    && completed.length === chunks.length
    && failed.length === 0
    && missingIds.length === 0
    && duplicateIds.length === 0
    && missingSourceIds.length === 0
    && invalidOutputs.length === 0;
  const checks = [
    { id: "snapshot_locked", passed: Boolean(plan.input.snapshotHash), label: "字幕版本和处理范围已锁定" },
    { id: "all_chunks_finished", passed: completed.length === chunks.length, label: `API 分块全部完成（${completed.length}/${chunks.length}）` },
    { id: "no_failed_chunks", passed: failed.length === 0, label: failed.length ? `${failed.length} 个分块失败` : "没有失败分块" },
    { id: "segment_coverage", passed: !missingIds.length && !duplicateIds.length, label: `知识段落覆盖 ${expectedIds.length - missingIds.length}/${expectedIds.length}` },
    { id: "source_segment_coverage", passed: !missingSourceIds.length, label: `源字幕覆盖 ${expectedSourceIds.length - missingSourceIds.length}/${expectedSourceIds.length}` },
    { id: "output_contract", passed: !invalidOutputs.length, label: invalidOutputs.length ? `${invalidOutputs.length} 个分块未确认完整性` : "所有分块已确认无遗漏" }
  ];
  const snapshot = {
    ...clone(plan.input.snapshotCore),
    createdAt: note.knowledge?.material?.snapshot?.snapshotHash === plan.input.snapshotHash
      ? note.knowledge.material.snapshot.createdAt
      : now(),
    snapshotHash: plan.input.snapshotHash
  };
  const materialHash = ready ? sha256Json({ snapshotHash: plan.input.snapshotHash, chunks: chunks.map((chunk) => [chunk.id, chunk.inputHash, chunk.output]) }) : "";
  return {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    status: ready ? "ready" : completed.length ? "partial" : "failed",
    taskId: task.id,
    provider: plan.provider,
    model: plan.model,
    snapshot,
    chunks,
    completeness: {
      ready,
      checks,
      chunkCount: chunks.length,
      completedChunkCount: completed.length,
      failedChunkCount: failed.length,
      expectedSegmentCount: expectedIds.length,
      expectedSourceSegmentCount: expectedSourceIds.length,
      processedSourceSegmentCount: completedSourceIds.length,
      missingSegmentIds: missingIds,
      missingSourceSegmentIds: missingSourceIds,
      duplicateSegmentIds: duplicateIds,
      invalidChunkIds: invalidOutputs
    },
    materialHash,
    updatedAt: now()
  };
}

function saveKnowledgeMaterial(note, task, plan) {
  note.knowledge = note.knowledge || {};
  note.knowledge.schemaVersion = KNOWLEDGE_SCHEMA_VERSION;
  note.knowledge.material = knowledgeMaterialFromTask(note, task, plan);
  note.knowledge.status = note.knowledge.material.completeness.ready ? "materials_ready" : "materials_partial";
  note.knowledge.audit = { status: "not_started", issues: [], checkedAt: "" };
  note.knowledge.synthesis = null;
  saveNote(note);
}

function assertKnowledgeMaterialReady(note) {
  const material = note.knowledge?.material;
  if (!material?.completeness?.ready || material.status !== "ready" || !material.materialHash) {
    throw new AppError("KNOWLEDGE_MATERIAL_INCOMPLETE", "API 资料还没有 100% 完整，Codex 已被后端锁住。", { completeness: material?.completeness || null }, 409);
  }
  const snapshot = material.snapshot;
  const current = buildKnowledgeInput(note, {
    pageIndex: snapshot.selected?.pageIndex,
    trackIndex: snapshot.selected?.trackIndex,
    pageScope: snapshot.scope?.pageScope,
    trackScope: snapshot.scope?.trackScope,
    transcriptMode: snapshot.transcriptMode
  });
  if (current.snapshotHash !== snapshot.snapshotHash) {
    invalidateKnowledge(note, "字幕、润色版或说话人信息已变更");
    saveNote(note);
    throw new AppError("KNOWLEDGE_MATERIAL_STALE", "字幕资料已变更，原快照失效。请重新执行 API 整理。", {}, 409);
  }
  return material;
}

async function executeKnowledgeExtraction(task, note, plan, reportProgress) {
  const total = task.chunks.length;
  note.knowledge = note.knowledge || {};
  note.knowledge.status = "extracting";
  saveNote(note);
  for (const [index, chunk] of task.chunks.entries()) {
    if (chunk.status === "completed" && chunk.output) continue;
    chunk.status = "running";
    chunk.attempts = Number(chunk.attempts || 0) + 1;
    chunk.startedAt = now();
    task.message = `API 正在整理第 ${index + 1}/${total} 块资料`;
    refreshTaskMetrics(task);
    saveTask(task);
    if (reportProgress) reportProgress(6 + Math.round((index / Math.max(1, total)) * 88), task.message);
    try {
      const payload = await callCanvasLlm({
        operation: "knowledge_chunk",
        engine: "api",
        message: buildKnowledgeChunkMessage(chunk, note),
        systemPrompt: aiSystemPrompt("knowledge_chunk"),
        provider: plan.provider,
        model: plan.model
      });
      chunk.output = normalizeKnowledgeChunkResponse(parseJsonResponse(payload.text), chunk);
      chunk.outputChars = JSON.stringify(chunk.output).length;
      chunk.outputTokens = estimateTokenCount(chunk.outputChars);
      chunk.model = safeString(payload.model || plan.model);
      chunk.status = "completed";
      chunk.completedAt = now();
      chunk.error = null;
    } catch (error) {
      chunk.status = "failed";
      chunk.error = { code: error.code || "KNOWLEDGE_CHUNK_FAILED", message: redactLogText(error.message), details: error.details || {} };
      chunk.failedAt = now();
    }
    refreshTaskMetrics(task);
    saveTask(task);
    saveKnowledgeMaterial(note, task, plan);
    if (reportProgress) {
      const completed = Number(task.metrics.completedChunkCount || 0);
      const failed = Number(task.metrics.failedChunkCount || 0);
      reportProgress(6 + Math.round(((index + 1) / Math.max(1, total)) * 88), failed
        ? `API 已处理 ${index + 1}/${total} 块，失败 ${failed} 块`
        : `API 已完成 ${completed}/${total} 块资料`);
    }
  }
  refreshTaskMetrics(task);
  saveTask(task);
  saveKnowledgeMaterial(note, task, plan);
  const failures = task.chunks.filter((chunk) => chunk.status === "failed");
  if (failures.length) {
    throw new AppError("KNOWLEDGE_MATERIAL_INCOMPLETE", `API 资料已完成 ${task.metrics.completedChunkCount}/${total} 块；Codex 仍保持锁定。`, {
      failedChunkIds: failures.map((chunk) => chunk.id), metrics: task.metrics, retryable: true
    }, 502);
  }
  return { operation: "knowledge_extract", noteId: note.id, materialHash: note.knowledge.material.materialHash, completeness: note.knowledge.material.completeness };
}

async function executeAlignmentAnalysis(task, note, plan, reportProgress) {
  const total = task.chunks.length;
  for (const [index, chunk] of task.chunks.entries()) {
    if (chunk.status === "completed") continue;
    chunk.status = "running";
    chunk.attempts = Number(chunk.attempts || 0) + 1;
    chunk.startedAt = now();
    task.message = `正在处理第 ${index + 1}/${total} 个分块`;
    refreshTaskMetrics(task);
    saveTask(task);
    if (reportProgress) reportProgress(Math.max(6, Math.round((index / Math.max(1, total)) * 86)), task.message);
    try {
      const message = buildChunkAnalysisMessage(plan.operation, chunk, note);
      const payload = await callCanvasLlm({
        operation: plan.operation,
        engine: plan.engine,
        message,
        systemPrompt: aiSystemPrompt(plan.operation),
        provider: plan.provider,
        model: plan.model
      });
      chunk.rawOutput = safeString(payload.text);
      chunk.receivedOutputChars = chunk.rawOutput.length;
      chunk.receivedOutputTokens = estimateTokenCount(chunk.receivedOutputChars);
      const normalized = plan.operation === "polish"
        ? normalizePolishBlockText(payload.text, chunk)
        : normalizeAlignedSegments(parseJsonResponse(payload.text), chunk.segments, plan.operation);
      const quality = plan.operation === "polish" ? assessPolishQuality(chunk.segments, normalized) : null;
      chunk.output = { segments: normalized, ...(quality ? { quality } : {}) };
      chunk.outputChars = normalized.reduce((sum, segment) => sum + String(segment.text || "").length, 0);
      chunk.outputTokens = estimateTokenCount(chunk.outputChars);
      chunk.model = safeString(payload.model || plan.model);
      chunk.status = "completed";
      chunk.completedAt = now();
      chunk.error = null;
      delete chunk.rawOutput;
      refreshTaskMetrics(task);
      saveTask(task);
      saveAlignmentPartial(note, task, plan.input, plan);
    } catch (error) {
      chunk.status = "failed";
      chunk.error = { code: error.code || "AI_CHUNK_FAILED", message: redactLogText(error.message), details: error.details || {} };
      chunk.failedAt = now();
      refreshTaskMetrics(task);
      saveTask(task);
      saveAlignmentPartial(note, task, plan.input, plan);
    }
  }
  // 重试时，已付费的 rawOutput 可能在进入循环前就被本地恢复为 completed。
  // 无论本轮是否真正调用 API，都要把已完成分块写回笔记。
  saveAlignmentPartial(note, task, plan.input, plan);
  refreshTaskMetrics(task);
  saveTask(task);
  const failures = task.chunks.filter((chunk) => chunk.status === "failed");
  if (failures.length) {
    throw new AppError(
      task.chunks.some((chunk) => chunk.status === "completed") ? "AI_PARTIAL_CHUNKS" : "AI_ALL_CHUNKS_FAILED",
      task.chunks.some((chunk) => chunk.status === "completed")
        ? `已完成 ${task.metrics.completedChunkCount}/${total} 个分块，${failures.length} 个分块失败。`
        : "所有 AI 分块都失败了。",
      {
        failedChunkIds: failures.map((chunk) => chunk.id),
        completedChunkIds: task.chunks.filter((chunk) => chunk.status === "completed").map((chunk) => chunk.id),
        metrics: task.metrics,
        retryable: true
      },
      502
    );
  }
  if (plan.operation === "polish") {
    const polishedSegments = task.chunks.flatMap((chunk) => chunk.output?.segments || []);
    const overallQuality = assessPolishQuality(plan.input.segments, polishedSegments);
    if (!overallQuality.passed) {
      const latestNote = loadNote(note.id);
      latestNote.transcript.polished.status = "quality_failed";
      latestNote.transcript.polished.quality = overallQuality;
      latestNote.transcript.polished.partialMessage = `润色质量未通过：${overallQuality.violations.join("；")}`;
      latestNote.processing.ai = "failed";
      saveNote(latestNote);
      throw new AppError("AI_POLISH_QUALITY_FAILED", latestNote.transcript.polished.partialMessage, { quality: overallQuality }, 502);
    }
    const latestNote = loadNote(note.id);
    latestNote.transcript.polished.quality = overallQuality;
    saveNote(latestNote);
  }
  return { operation: plan.operation, noteId: note.id, scope: plan.input.scope, sourceCount: plan.input.sources.length, segmentCount: plan.input.segments.length, metrics: task.metrics };
}

function compactGlobalCandidates(operation, chunkResults) {
  return chunkResults.map((item) => {
    // executeStructuredPart 传入的是已完成 chunk，老的单元测试则使用
    // { chunk, output } 包装。同时兼容两种形状，避免在模型已成功后
    // 因读取 item.chunk.id 而把全局合并误判为失败。
    const chunk = item?.chunk || item;
    const output = item?.output || chunk?.output;
    return {
      chunkId: chunk.id,
      index: chunk.index,
      sourceKeys: chunk.sourceKeys,
      ...(operation === "outline"
        ? { chapters: (output?.chapters || []).slice(0, 2).map((node) => ({
          id: node.id,
          title: outlineExcerptText(node.title, 34),
          summary: outlineExcerptText(node.summary, 48),
          keyPoints: node.keyPoints?.slice(0, 1).map((point) => outlineExcerptText(point, 30)) || [],
          segmentIds: node.segmentIds?.slice(0, 2) || []
        })) }
        : { concepts: (output?.concepts || []).slice(0, 3).map((node) => ({
          id: node.id,
          label: outlineExcerptText(node.label, 34),
          summary: outlineExcerptText(node.summary, 48),
          relation: outlineExcerptText(node.relation, 18),
          keywords: node.keywords?.slice(0, 2).map((keyword) => outlineExcerptText(keyword, 18)) || [],
          segmentIds: node.segmentIds?.slice(0, 2) || []
        })) })
    };
  });
}

async function executeStructuredPart(task, note, plan, operation, part, reportProgress) {
  const label = operation === "outline" ? "文字大纲" : "思维导图";
  if (part.status === "completed" && part.output?.tree) {
    return { operation, tree: part.output.tree, partial: false, failedChunks: [], globalError: null, reused: true };
  }
  const chunks = part.chunks;
  const total = chunks.length;
  const successful = [];
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.status === "completed" && chunk.output) {
      successful.push(chunk);
      continue;
    }
    chunk.status = "running";
    chunk.attempts = Number(chunk.attempts || 0) + 1;
    chunk.startedAt = now();
    part.status = "running";
    task.message = `正在提取${label} ${index + 1}/${total}`;
    refreshTaskMetrics(task);
    saveTask(task);
    if (reportProgress) reportProgress(8 + Math.round((index / Math.max(1, total)) * 66), task.message);
    try {
      const chunkOperation = `${operation}_chunk`;
      const message = buildChunkAnalysisMessage(operation === "outline" ? "outline" : "mindmap", chunk, note);
      const payload = await callCanvasLlm({
        operation: chunkOperation,
        engine: plan.engine,
        message,
        systemPrompt: aiSystemPrompt(chunkOperation),
        provider: plan.provider,
        model: plan.model
      });
      const parsed = parseJsonResponse(payload.text);
      chunk.output = operation === "outline"
        ? normalizeChunkOutlineResponse(parsed, chunk)
        : normalizeChunkMindmapResponse(parsed, chunk);
      chunk.outputChars = JSON.stringify(chunk.output).length;
      chunk.outputTokens = estimateTokenCount(chunk.outputChars);
      chunk.model = safeString(payload.model || plan.model);
      chunk.status = "completed";
      chunk.completedAt = now();
      chunk.error = null;
      successful.push(chunk);
    } catch (error) {
      chunk.status = "failed";
      chunk.error = { code: error.code || "AI_CHUNK_FAILED", message: redactLogText(error.message), details: error.details || {} };
      chunk.failedAt = now();
    }
    refreshTaskMetrics(task);
    saveTask(task);
  }

  const failedChunks = chunks.filter((chunk) => chunk.status === "failed");
  if (!successful.length) {
    part.status = "failed";
    part.globalStatus = "failed";
    part.error = { code: "AI_ALL_CHUNKS_FAILED", message: `${label}所有分块都失败了。`, failedChunkIds: failedChunks.map((chunk) => chunk.id) };
    saveTask(task);
    throw new AppError("AI_ALL_CHUNKS_FAILED", part.error.message, { failedChunkIds: part.error.failedChunkIds, retryable: true }, 502);
  }

  part.globalStatus = "running";
  saveTask(task);
  let tree;
  let globalError = null;
  try {
    const message = buildGlobalStructureMessage(operation, plan.input, successful, note);
    const payload = await callCanvasLlm({
      operation: `${operation}_merge`,
      engine: plan.engine,
      message,
      systemPrompt: aiSystemPrompt(`${operation}_merge`),
      provider: plan.provider,
      model: plan.model
    });
    const parsed = parseJsonResponse(payload.text);
    const rawTree = operation === "outline"
      ? parsed?.outline || parsed?.textOutline || parsed
      : parsed?.mindmap || parsed?.mindMap || parsed;
    tree = operation === "outline"
      ? sanitizeOutlineTree(rawTree, plan.input.segments)
      : sanitizeMindmapTree(rawTree, plan.input.segments);
    part.model = safeString(payload.model || plan.model);
  } catch (error) {
    globalError = error;
    try {
      tree = operation === "outline"
        ? fallbackOutlineTree(successful, plan.input.segments, note)
        : fallbackMindmapTree(successful, plan.input.segments, note);
    } catch (fallbackError) {
      tree = null;
      globalError = fallbackError;
    }
  }
  if (!tree) {
    part.status = "failed";
    part.globalStatus = "failed";
    part.error = { code: globalError?.code || "AI_STRUCTURE_FAILED", message: globalError?.message || `${label}合并失败。` };
    saveTask(task);
    throw new AppError(part.error.code, part.error.message, { failedChunkIds: failedChunks.map((chunk) => chunk.id), retryable: true }, 502);
  }
  part.output = { tree, generatedAt: now(), partial: Boolean(failedChunks.length || globalError), failedChunkIds: failedChunks.map((chunk) => chunk.id) };
  part.status = failedChunks.length || globalError ? "partial" : "completed";
  part.globalStatus = globalError ? "failed" : "completed";
  part.error = globalError ? { code: globalError.code || "AI_GLOBAL_MERGE_FAILED", message: redactLogText(globalError.message) } : null;
  refreshTaskMetrics(task);
  saveTask(task);
  return { operation, tree, partial: part.status === "partial", failedChunks, globalError };
}

async function executeStructureAnalysis(task, note, plan, reportProgress) {
  if (reportProgress) reportProgress(8, "正在并行处理文字大纲和思维导图分块");
  const entries = [
    ["outline", task.parts.outline],
    ["mindmap", task.parts.mindmap]
  ];
  const settled = await Promise.allSettled(entries.map(([operation, part]) => executeStructuredPart(task, note, plan, operation, part, reportProgress)));
  const generated = [];
  const failures = [];
  for (const [index, result] of settled.entries()) {
    const [operation, part] = entries[index];
    if (result.status === "fulfilled") {
      const target = operation === "outline" ? "outline" : "mindmap";
      note[target] = {
        ...(note[target] || {}),
        status: result.value.partial ? "partial" : "ready",
        tree: result.value.tree,
        generatedAt: now(),
        engine: plan.engine,
        provider: plan.provider,
        model: part.model || plan.model,
        scope: plan.input.scope,
        inputFingerprint: plan.fingerprint,
        chunkCount: part.chunks.length,
        completedChunkCount: part.chunks.filter((chunk) => chunk.status === "completed").length,
        failedChunkIds: part.chunks.filter((chunk) => chunk.status === "failed").map((chunk) => chunk.id),
        partialMessage: result.value.partial ? "部分分块已完成，可只重试失败分块。" : ""
      };
      generated.push({ operation, partial: result.value.partial });
      if (result.value.partial) failures.push({ operation, label: operation === "outline" ? "文字大纲" : "思维导图", code: "AI_PARTIAL_CHUNKS", message: "部分分块或全局合并失败。" });
    } else {
      const error = result.reason || {};
      failures.push({ operation, label: operation === "outline" ? "文字大纲" : "思维导图", code: error.code || "AI_STRUCTURE_FAILED", message: error.message || "结构生成失败。" });
      part.status = "failed";
      part.error = { code: error.code || "AI_STRUCTURE_FAILED", message: redactLogText(error.message) };
    }
  }
  if (generated.length) {
    note.settings = { ...(note.settings || {}), provider: plan.provider, model: plan.model };
    note.processing.ai = failures.length ? "partial" : "ready";
    note.status = "ready";
    saveNote(note);
  }
  refreshTaskMetrics(task);
  saveTask(task);
  if (failures.length) {
    throw new AppError(
      generated.length ? "AI_PARTIAL_STRUCTURE" : "AI_STRUCTURE_FAILED",
      generated.length ? `已生成${generated.map((item) => item.operation === "outline" ? "文字大纲" : "思维导图").join("、")}，但仍有分块失败。` : "文字大纲和思维导图均生成失败。",
      { generated: generated.map((item) => item.operation), failed: failures, parallel: true, metrics: task.metrics, retryable: true },
      502
    );
  }
  return { operation: "structure", noteId: note.id, scope: plan.input.scope, sourceCount: plan.input.sources.length, segmentCount: plan.input.segments.length, generated: generated.map((item) => item.operation), parallel: true, metrics: task.metrics };
}

async function executeAnalysis(task, reportProgress) {
  const note = loadNote(task.noteId);
  const request = task.analysis?.request;
  const input = task.analysis?.input;
  if (!request || !input) throw new AppError("TASK_PLAN_MISSING", "任务缺少可恢复的分块计划，请重新提交 AI 任务。", {}, 409);
  const plan = {
    ...request,
    input,
    chunks: task.chunks || task.analysis.baseChunks,
    fingerprint: task.meta?.inputFingerprint,
    inputChars: task.meta?.inputChars,
    inputTokens: task.meta?.inputTokens
  };
  if (request.operation === "knowledge_extract") return executeKnowledgeExtraction(task, note, plan, reportProgress);
  if (request.operation === "knowledge_synthesize") return executeKnowledgeSynthesis(task, note, reportProgress);
  if (request.operation === "translate") {
    throw new AppError("TRANSLATION_REMOVED", "翻译功能已移除，旧翻译任务不能继续执行。", { taskId: task.id }, 410);
  }
  if (request.operation === "polish") return executeAlignmentAnalysis(task, note, plan, reportProgress);
  if (["outline", "mindmap"].includes(request.operation)) {
    const part = task.parts?.[request.operation];
    if (!part) throw new AppError("TASK_PLAN_MISSING", "结构任务缺少分块计划。", {}, 409);
    const result = await executeStructuredPart(task, note, plan, request.operation, part, reportProgress);
    const target = request.operation === "outline" ? "outline" : "mindmap";
    note[target] = {
      ...(note[target] || {}),
      status: result.partial ? "partial" : "ready",
      tree: result.tree,
      generatedAt: now(),
      engine: plan.engine,
      provider: plan.provider,
      model: part.model || plan.model,
      scope: input.scope,
      inputFingerprint: plan.fingerprint,
      chunkCount: part.chunks.length,
      completedChunkCount: part.chunks.filter((chunk) => chunk.status === "completed").length,
      failedChunkIds: part.chunks.filter((chunk) => chunk.status === "failed").map((chunk) => chunk.id),
      partialMessage: result.partial ? "部分分块已完成，可只重试失败分块。" : ""
    };
    note.settings = { ...(note.settings || {}), provider: plan.provider, model: plan.model };
    note.processing.ai = result.partial ? "partial" : "ready";
    note.status = "ready";
    saveNote(note);
    if (result.partial) throw new AppError("AI_PARTIAL_STRUCTURE", `${request.operation === "outline" ? "文字大纲" : "思维导图"}部分完成，仍有失败分块。`, { failedChunkIds: result.failedChunks.map((chunk) => chunk.id), retryable: true, metrics: task.metrics }, 502);
    return { operation: request.operation, noteId: note.id, scope: input.scope, sourceCount: input.sources.length, segmentCount: input.segments.length, metrics: task.metrics };
  }
  if (request.operation === "structure") return executeStructureAnalysis(task, note, plan, reportProgress);
  throw new AppError("INVALID_ANALYSIS", "任务操作类型不正确。", {}, 400);
}

function previewCodexFileTask(note, operation) {
  const settings = loadSettings();
  if (operation === "sync_obsidian") {
    assertKnowledgeMaterialReady(note);
    if (note.knowledge?.status !== "ready" || note.knowledge?.audit?.status !== "PASS" || note.knowledge?.synthesis?.materialHash !== note.knowledge?.material?.materialHash) {
      throw new AppError("KNOWLEDGE_NOT_PUBLISHABLE", "只有 API 资料完整且 Codex 核查 PASS 的总输出，才能写入 Obsidian。", {}, 409);
    }
  }
  const markdown = buildMarkdown(note);
  let targetPath;
  if (operation === "sync_obsidian") targetPath = obsidianPathFor(note, settings);
  else if (operation === "write_markdown") {
    const identifier = sourceId(note) || note.id;
    targetPath = path.join(EXPORTS_DIR, `${safeSlug(note.title, identifier)}-${identifier}.md`);
  }
  else throw new AppError("INVALID_CODEX_FILE_OPERATION", "暂不支持这个 Codex 文件操作。", {}, 400);
  return {
    operation,
    noteId: note.id,
    targetPath,
    action: fs.existsSync(targetPath) ? "update" : "create",
    bytes: Buffer.byteLength(markdown),
    contentHash: crypto.createHash("sha256").update(markdown).digest("hex"),
    preview: markdown.slice(0, 4000),
    fullContent: markdown
  };
}

function createCodexFilePreview(note, operation) {
  const task = createTask("codex_file", note.id, { operation });
  task.status = "awaiting_confirmation";
  task.progress = 0;
  task.message = "等待确认文件变更";
  task.plan = previewCodexFileTask(note, operation);
  saveTask(task);
  return task;
}

function executeCodexFileTask(task) {
  const plan = task.plan;
  if (!plan?.targetPath || !plan.fullContent) throw new AppError("INVALID_CODEX_FILE_TASK", "文件任务内容不完整。", {}, 400);
  const targetPath = path.resolve(plan.targetPath);
  const currentNote = loadNote(task.noteId);
  const currentMarkdown = buildMarkdown(currentNote);
  const currentHash = crypto.createHash("sha256").update(currentMarkdown).digest("hex");
  if (!plan.contentHash || currentHash !== plan.contentHash) {
    throw new AppError("EXPORT_CHANGED_AFTER_PREVIEW", "笔记在预览后发生了变化，已取消写入。请重新预览并确认。", {}, 409);
  }
  const allowedRoots = [path.resolve(DATA_DIR)];
  const settings = loadSettings();
  if (settings.obsidianVaultPath) allowedRoots.push(path.resolve(settings.obsidianVaultPath));
  if (!allowedRoots.some((root) => targetPath === root || targetPath.startsWith(`${root}${path.sep}`))) {
    throw new AppError("CODEX_PATH_FORBIDDEN", "Codex 文件任务超出了允许写入的目录。", {}, 403);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  writeJsonOrTextAtomic(targetPath, plan.fullContent);
  appendJsonLine(CODEX_LOG_FILE, {
    taskId: task.id,
    noteId: task.noteId,
    operation: plan.operation,
    targetPath,
    at: now()
  });
  return { targetPath, action: plan.action };
}

function writeJsonOrTextAtomic(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, content, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function codexCliExecutable() {
  const configured = safeString(process.env.CODEX_BIN);
  if (configured) return configured;
  // The desktop app is updated independently from user-installed CLIs. Prefer
  // its bundled binary so newly selected Codex models are not sent through an
  // older ~/.local/bin/codex that cannot understand them.
  if (process.platform === "darwin") {
    const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex";
    try {
      fs.accessSync(bundled, fs.constants.X_OK);
      return bundled;
    } catch {
      // Fall back to PATH for machines without the desktop app.
    }
  }
  const candidates = process.platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"];
  for (const candidate of candidates) {
    try {
      const result = require("node:child_process").execFileSync(process.platform === "win32" ? "where" : "which", [candidate], { encoding: "utf8" }).trim();
      if (result) return result.split(/\r?\n/)[0];
    } catch {
      // Continue looking.
    }
  }
  return "";
}

function summarizeCodexFailure(stderr, stdout, maxLength = 900) {
  const lines = safeString(stderr || stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fatalLines = lines.filter((line) => /(?:^|\s)(?:ERROR|Error:)|invalid_request_error|requires a newer version/i.test(line));
  const selected = fatalLines.length ? fatalLines : lines.slice(-8);
  return redactLogText([...new Set(selected)].slice(-4).join("\n"), maxLength) || "Codex 进程异常退出，未返回可诊断信息。";
}

function codexKnowledgePrompt(packagePath) {
  return `你是视频知识库的严格审计员和编辑。请只读取这个完整资料包：${packagePath}

你必须先审计，再合成；不能补全资料，不能查网页，不能引入外部事实，不能修改项目文件。
审计项：快照与分块清单是否一致；是否每块都完成并确认无遗漏；所有知识项的 segmentIds 是否存在；说话人是否与证据一致；是否有互相矛盾或无法支撑的关键结论。
只有上述项目全部通过，audit.status 才能是 PASS；否则必须是 BLOCKED，并且 synthesis 必须是 null。每个问题尽量指明 chunkIds 和 segmentIds。

PASS 时的合成原则：
- 覆盖全部资料块，去重但不丢掉少数观点、例外、反对观点和案例。
- 区分 fact/opinion/prediction/advice/example/question/counterpoint。
- 核心结论、大纲节点、案例、行动项、争议点都要引用真实 segmentIds。
- 思维导图按概念关系组织，不是大纲换名。
- knowledgeCards 是候选原子笔记，标题稳定、内容可独立理解，并有 segmentIds。

只返回合法 JSON，不要 Markdown 围栏：
{"audit":{"status":"PASS|BLOCKED","summary":"","issues":[{"code":"","message":"","chunkIds":[],"segmentIds":[]}]},"synthesis":null或{"oneSentenceSummary":"","whyItMatters":"","coreConclusions":[{"id":"","title":"","statement":"","type":"opinion","speakerId":"","speakerLabel":"","segmentIds":[],"needsExternalVerification":false}],"outline":{"title":"","summary":"","items":[{"id":"","title":"","summary":"","keyPoints":[],"segmentIds":[],"children":[]}]},"mindmap":{"id":"root","label":"","summary":"","relation":"","keywords":[],"segmentIds":[],"children":[{"id":"","label":"","summary":"","relation":"包含|导致|对比|依赖|建议|例证","keywords":[],"segmentIds":[],"children":[]}]},"cases":[{"title":"","summary":"","segmentIds":[]}],"actions":[{"title":"","detail":"","segmentIds":[]}],"controversies":[{"title":"","detail":"","segmentIds":[]}],"knowledgeCards":[{"title":"","summary":"","concepts":[],"segmentIds":[]}]}}`;
}

async function runCodexKnowledge(packagePath, model = "") {
  if (aiCallOverride) {
    const payload = await aiCallOverride({ operation: "knowledge_synthesize", engine: "codex", message: packagePath, systemPrompt: codexKnowledgePrompt(packagePath), provider: "codex", model });
    return { text: payload.text, model: payload.model || model || "test-codex" };
  }
  const executable = codexCliExecutable();
  if (!executable) throw new AppError("CODEX_NOT_INSTALLED", "本机没有找到 Codex CLI，无法执行核查合成。", {}, 503);
  const outputPath = path.join(path.dirname(packagePath), "codex-result.txt");
  const args = ["exec", "--cd", __dirname, "--sandbox", "read-only", "--skip-git-repo-check"];
  if (safeString(model)) args.push("--model", safeString(model));
  args.push("--output-last-message", outputPath, "-");
  const timeoutMs = Math.max(60_000, Math.min(3_600_000, Number(process.env.KNOWLEDGE_CODEX_TIMEOUT_MS || 1_800_000)));
  const prompt = codexKnowledgePrompt(packagePath);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new AppError("CODEX_TIMEOUT", "Codex 核查合成超时，API 资料不会丢失，可直接重试 Codex。", {}, 504));
    }, timeoutMs);
    child.stdout.on("data", (data) => { stdout += data.toString("utf8"); });
    child.stderr.on("data", (data) => { stderr += data.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new AppError("CODEX_START_FAILED", `Codex 无法启动：${redactLogText(error.message)}`, {}, 502));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new AppError("CODEX_FAILED", `Codex 执行失败：${summarizeCodexFailure(stderr, stdout)}`, { exitCode: code }, 502));
      const text = safeString(fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : stdout);
      resolve({ text, model: safeString(model || "codex-cli-default") });
    });
    child.stdin.end(prompt, "utf8");
  });
}

function normalizeEvidenceIds(values, allowedIds, context) {
  const ids = [...new Set((Array.isArray(values) ? values : []).map(safeString).filter(Boolean))];
  const invalid = ids.filter((segmentId) => !allowedIds.has(segmentId));
  if (invalid.length) throw new AppError("CODEX_INVALID_REFERENCE", `Codex 在${context}中引用了不存在的字幕。`, { invalid, context }, 502);
  return ids;
}

function normalizeCodexSynthesis(parsed, material) {
  const audit = parsed?.audit || {};
  const status = safeString(audit.status).toUpperCase();
  if (!['PASS', 'BLOCKED'].includes(status)) throw new AppError("CODEX_AUDIT_INVALID", "Codex 审计结果只允许 PASS 或 BLOCKED。", {}, 502);
  const chunkIds = new Set(material.chunks.map((chunk) => chunk.id));
  const segmentIds = new Set(material.snapshot.segments.map((segment) => segment.segmentId));
  const segmentMap = new Map(material.snapshot.segments.map((segment) => [segment.segmentId, segment]));
  const issues = (Array.isArray(audit.issues) ? audit.issues : []).map((issue) => ({
    code: safeString(issue?.code || "AUDIT_ISSUE"),
    message: safeString(issue?.message),
    chunkIds: [...new Set((Array.isArray(issue?.chunkIds) ? issue.chunkIds : []).map(safeString).filter((value) => chunkIds.has(value)))],
    segmentIds: normalizeEvidenceIds(issue?.segmentIds, segmentIds, "审计问题")
  }));
  const normalizedAudit = { status, summary: safeString(audit.summary), issues, checkedAt: now() };
  if (status === "BLOCKED") return { audit: normalizedAudit, synthesis: null };
  if (!parsed?.synthesis || typeof parsed.synthesis !== "object") throw new AppError("CODEX_SYNTHESIS_MISSING", "Codex 审计通过但没有返回合成结果。", {}, 502);
  const source = parsed.synthesis;
  const evidenceList = (values, context, required = true) => {
    const ids = normalizeEvidenceIds(values, segmentIds, context);
    if (required && !ids.length) throw new AppError("CODEX_EVIDENCE_MISSING", `${context}没有字幕证据。`, {}, 502);
    return ids;
  };
  const allowedTypes = new Set(["fact", "opinion", "prediction", "advice", "example", "question", "counterpoint"]);
  const conclusions = (Array.isArray(source.coreConclusions) ? source.coreConclusions : []).map((item, index) => {
    const evidenceIds = evidenceList(item?.segmentIds, `核心结论 ${index + 1}`);
    const evidenceSpeakers = [...new Set(evidenceIds.map((segmentId) => safeString(segmentMap.get(segmentId)?.speakerId)).filter(Boolean))];
    const claimedSpeaker = safeString(item?.speakerId);
    if (claimedSpeaker && !evidenceSpeakers.includes(claimedSpeaker)) {
      throw new AppError("CODEX_SPEAKER_MISMATCH", `核心结论 ${index + 1} 的说话人与字幕证据不符。`, { claimedSpeaker, evidenceSpeakers }, 502);
    }
    const type = safeString(item?.type || "opinion");
    if (!allowedTypes.has(type)) throw new AppError("CODEX_KNOWLEDGE_TYPE_INVALID", `核心结论 ${index + 1} 的类型不合法。`, { type }, 502);
    return {
      id: safeString(item?.id) || `conclusion-${index + 1}`,
      title: safeString(item?.title), statement: safeString(item?.statement), type,
      speakerId: evidenceSpeakers.length === 1 ? evidenceSpeakers[0] : "",
      speakerLabel: evidenceSpeakers.length === 1 ? safeString(segmentMap.get(evidenceIds.find((segmentId) => segmentMap.get(segmentId)?.speakerId === evidenceSpeakers[0]))?.speakerLabel) : "",
      segmentIds: evidenceIds, needsExternalVerification: Boolean(item?.needsExternalVerification)
    };
  }).filter((item) => item.title && item.statement);
  if (!conclusions.length) throw new AppError("CODEX_SYNTHESIS_EMPTY", "Codex 没有生成可用的核心结论。", {}, 502);
  const outlineNode = (item, index, depth = 0) => ({
    id: safeString(item?.id) || `outline-${depth + 1}-${index + 1}`,
    title: safeString(item?.title), summary: safeString(item?.summary),
    keyPoints: (Array.isArray(item?.keyPoints) ? item.keyPoints : []).map(safeString).filter(Boolean),
    segmentIds: evidenceList(item?.segmentIds, `大纲节点 ${index + 1}`),
    children: depth < 2 ? (Array.isArray(item?.children) ? item.children : []).map((child, childIndex) => outlineNode(child, childIndex, depth + 1)).filter((child) => child.title) : []
  });
  const outlineItems = (Array.isArray(source.outline?.items) ? source.outline.items : []).map(outlineNode).filter((item) => item.title);
  if (!outlineItems.length) throw new AppError("CODEX_OUTLINE_EMPTY", "Codex 没有生成可用的全局大纲。", {}, 502);
  const mindNode = (item, index, depth = 0) => ({
    id: safeString(item?.id) || `mind-${depth + 1}-${index + 1}`,
    label: safeString(item?.label), summary: safeString(item?.summary), relation: safeString(item?.relation),
    keywords: (Array.isArray(item?.keywords) ? item.keywords : []).map(safeString).filter(Boolean),
    segmentIds: evidenceList(item?.segmentIds, `导图节点 ${index + 1}`, depth > 0),
    children: depth < 2 ? (Array.isArray(item?.children) ? item.children : []).map((child, childIndex) => mindNode(child, childIndex, depth + 1)).filter((child) => child.label) : []
  });
  const mindmap = mindNode(source.mindmap || {}, 0);
  if (!mindmap.label || !mindmap.children.length) throw new AppError("CODEX_MINDMAP_EMPTY", "Codex 没有生成可用的概念关系图。", {}, 502);
  const normalizeSection = (values, fields, label) => (Array.isArray(values) ? values : []).map((item, index) => ({
    ...Object.fromEntries(fields.map((field) => [field, safeString(item?.[field])])),
    segmentIds: evidenceList(item?.segmentIds, `${label} ${index + 1}`)
  })).filter((item) => fields.some((field) => item[field]));
  return {
    audit: normalizedAudit,
    synthesis: {
      oneSentenceSummary: safeString(source.oneSentenceSummary),
      whyItMatters: safeString(source.whyItMatters),
      coreConclusions: conclusions,
      outline: { title: safeString(source.outline?.title), summary: safeString(source.outline?.summary), items: outlineItems },
      mindmap,
      cases: normalizeSection(source.cases, ["title", "summary"], "案例"),
      actions: normalizeSection(source.actions, ["title", "detail"], "行动项"),
      controversies: normalizeSection(source.controversies, ["title", "detail"], "争议点"),
      knowledgeCards: (Array.isArray(source.knowledgeCards) ? source.knowledgeCards : []).map((item, index) => ({
        title: safeString(item?.title), summary: safeString(item?.summary),
        concepts: (Array.isArray(item?.concepts) ? item.concepts : []).map(safeString).filter(Boolean),
        segmentIds: evidenceList(item?.segmentIds, `知识卡片 ${index + 1}`)
      })).filter((item) => item.title && item.summary)
    }
  };
}

function createKnowledgeSynthesisTask(note, body = {}) {
  const material = assertKnowledgeMaterialReady(note);
  if (note.knowledge?.audit?.status === "BLOCKED" && note.knowledge.audit.materialHash === material.materialHash) {
    throw new AppError("KNOWLEDGE_AUDIT_BLOCKED", "同一份资料包已被 Codex 审计阻止。请先重新执行 API 资料整理，不允许靠反复生成绕过审计。", { issues: note.knowledge.audit.issues || [] }, 409);
  }
  const task = createTask("analysis", note.id, {
    operation: "knowledge_synthesize", engine: "codex", provider: "codex", model: safeString(body.model),
    pageScope: material.snapshot.scope?.pageScope, trackScope: material.snapshot.scope?.trackScope,
    sourceCount: material.snapshot.sources.length, segmentCount: material.snapshot.segments.length,
    chunkCount: material.chunks.length, inputChars: JSON.stringify(material).length,
    inputFingerprint: sha256Json({ materialHash: material.materialHash, model: safeString(body.model) })
  });
  task.analysis = { request: { operation: "knowledge_synthesize", engine: "codex", model: safeString(body.model), materialHash: material.materialHash }, input: { materialHash: material.materialHash } };
  saveTask(task);
  return task;
}

async function executeKnowledgeSynthesis(task, note, reportProgress) {
  const material = assertKnowledgeMaterialReady(note);
  if (material.materialHash !== task.analysis?.request?.materialHash) throw new AppError("KNOWLEDGE_MATERIAL_CHANGED", "Codex 任务对应的资料包已改变，请重新启动核查。", {}, 409);
  const directory = path.join(TEMP_DIR, "knowledge", task.id);
  fs.mkdirSync(directory, { recursive: true });
  const packagePath = path.join(directory, "materials.json");
  writeJsonAtomic(packagePath, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION, note: { id: note.id, title: note.title, source: note.source }, material });
  note.knowledge.status = "reviewing";
  note.knowledge.audit = { status: "running", issues: [], checkedAt: "" };
  saveNote(note);
  if (reportProgress) reportProgress(18, "Codex 正在先核查资料完整性");
  const payload = await runCodexKnowledge(packagePath, task.analysis.request.model);
  if (reportProgress) reportProgress(86, "Codex 核查完成，正在校验合成结果");
  const result = normalizeCodexSynthesis(parseJsonResponse(payload.text), material);
  note.knowledge.audit = { ...result.audit, model: payload.model, materialHash: material.materialHash };
  if (result.audit.status === "BLOCKED") {
    note.knowledge.status = "blocked";
    note.knowledge.synthesis = null;
    saveNote(note);
    return { operation: "knowledge_synthesize", auditStatus: "BLOCKED", issueCount: result.audit.issues.length, published: false };
  }
  note.knowledge.synthesis = { ...result.synthesis, generatedAt: now(), engine: "codex", model: payload.model, materialHash: material.materialHash };
  note.knowledge.status = "ready";
  saveNote(note);
  return { operation: "knowledge_synthesize", auditStatus: "PASS", published: true, materialHash: material.materialHash };
}

function restoreInterruptedKnowledgeState(note) {
  if (!note?.knowledge || !["extracting", "reviewing"].includes(note.knowledge.status)) return false;
  const material = note.knowledge.material;
  note.knowledge.status = material?.completeness?.ready && material?.status === "ready"
    ? "materials_ready"
    : material
      ? "materials_partial"
      : "not_started";
  if (note.knowledge.audit?.status === "running") {
    note.knowledge.audit = {
      ...note.knowledge.audit,
      status: "not_started",
      issues: [],
      checkedAt: ""
    };
  }
  return true;
}

function markInterruptedTasks() {
  for (const filename of fs.readdirSync(TASKS_DIR)) {
    if (!filename.endsWith(".json")) continue;
    const task = readJsonFile(path.join(TASKS_DIR, filename), null);
    if (task && ["queued", "running"].includes(task.status)) {
      task.status = "interrupted";
      task.message = "服务重启，中断后可重试";
      task.updatedAt = now();
      writeJsonAtomic(path.join(TASKS_DIR, filename), task);
      if (task.type === "analysis") appendGenerationEvent(task, "interrupted");
      if (task.type === "analysis") appendOperationEvent(task.noteId, "ai_task_interrupted", {
        taskId: task.id,
        operation: task.meta?.operation,
        completedChunkCount: task.metrics?.completedChunkCount || 0,
        message: task.message
      });
      if (task.type === "asr") {
        appendOperationEvent(task.noteId, "asr_task_interrupted", { taskId: task.id, stage: task.meta?.stage, message: task.message });
        try {
          const note = loadNote(task.noteId);
          note.processing = { ...(note.processing || {}), asr: "failed" };
          note.asr = { ...(note.asr || {}), status: "interrupted", taskId: task.id, failedStage: task.meta?.stage, failedAt: now() };
          saveNote(note);
        } catch {
          // Task recovery remains available even if its note was moved externally.
        }
      }
      if (task.type === "diarization") {
        appendOperationEvent(task.noteId, "diarization_task_interrupted", { taskId: task.id, stage: task.meta?.stage, message: task.message });
        try {
          const note = loadNote(task.noteId);
          note.processing = { ...(note.processing || {}), diarization: "failed" };
          note.speaker = { ...(note.speaker || {}), status: "interrupted", taskId: task.id, failedStage: task.meta?.stage, failedAt: now() };
          saveNote(note);
        } catch {
          // Task recovery remains available even if its note was moved externally.
        }
      }
    }
  }
  // 服务被中止时，任务文件会恢复为 interrupted；笔记也必须同步退回可重试状态。
  // 否则新页面会一直显示“API 整理中”，虽然后台已经没有任务在跑。
  for (const filename of fs.readdirSync(NOTES_DIR)) {
    if (!filename.endsWith(".json")) continue;
    const note = readJsonFile(path.join(NOTES_DIR, filename), null);
    if (!note || !restoreInterruptedKnowledgeState(note)) continue;
    const hasActiveKnowledgeTask = listAnalysisTasks(note.id).some((task) => (
      ["knowledge_extract", "knowledge_synthesize"].includes(task.meta?.operation)
      && ["queued", "running"].includes(task.status)
    ));
    if (!hasActiveKnowledgeTask) saveNote(note);
  }
}

function cleanupStaleAsrTempDirectories() {
  try {
    for (const name of fs.readdirSync(ASR_TEMP_DIR)) {
      if (!/^task_[a-z0-9]+$/i.test(name)) continue;
      fs.rmSync(path.join(ASR_TEMP_DIR, name), { recursive: true, force: true });
    }
  } catch (error) {
    console.error(`[asr-temp-cleanup] ${error.message}`);
  }
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav"
  }[extension] || "application/octet-stream";
}

function serveStatic(req, res, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    text(res, 403, "Forbidden");
    return;
  }
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      text(res, 404, "Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mimeType(filePath), "Cache-Control": "no-cache" });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function serveNoteCover(note, res) {
  const coverUrl = safeString(note.source?.cover);
  if (!coverUrl) {
    text(res, 404, "Cover not found");
    return;
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(coverUrl);
  } catch {
    text(res, 400, "Invalid cover URL");
    return;
  }
  const hostAllowed = /(^|\.)hdslb\.com$/i.test(parsedUrl.hostname)
    || /(^|\.)bilibili\.com$/i.test(parsedUrl.hostname)
    || /(^|\.)douyinpic\.com$/i.test(parsedUrl.hostname)
    || /(^|\.)byteimg\.com$/i.test(parsedUrl.hostname)
    || /(^|\.)bytedance\.com$/i.test(parsedUrl.hostname);
  if (!hostAllowed || !["http:", "https:"].includes(parsedUrl.protocol)) {
    text(res, 403, "Cover host is not allowed");
    return;
  }
  try {
    const response = await fetch(parsedUrl, {
      headers: sourceProvider(note) === "douyin" ? DOUYIN_HEADERS : BILIBILI_HEADERS,
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      text(res, response.status === 404 ? 404 : 502, "Cover is unavailable");
      return;
    }
    const contentType = safeString(response.headers.get("content-type") || "image/jpeg");
    if (!contentType.startsWith("image/")) {
      text(res, 502, "Cover response is not an image");
      return;
    }
    const body = Buffer.from(await response.arrayBuffer());
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": body.length,
      "Cache-Control": "public, max-age=86400"
    });
    res.end(body);
  } catch (error) {
    text(res, 502, `Cover request failed: ${error.message}`);
  }
}

function uploadedMediaExtension(req) {
  const filename = safeString(req.headers["x-file-name"]);
  const requested = path.extname(filename).toLowerCase();
  if ([".mp4", ".m4v", ".mov", ".webm", ".mp3", ".m4a", ".wav"].includes(requested)) return requested;
  const contentType = safeString(req.headers["content-type"]).split(";")[0].toLowerCase();
  return {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav"
  }[contentType] || "";
}

async function receiveNoteMedia(note, req) {
  const extension = uploadedMediaExtension(req);
  if (!extension) throw new AppError("MEDIA_TYPE_UNSUPPORTED", "请选择 MP4、MOV、WebM、MP3、M4A 或 WAV 文件。", {}, 415);
  const declaredBytes = Number(req.headers["content-length"] || 0);
  const maxBytes = 4 * 1024 * 1024 * 1024;
  if (declaredBytes > maxBytes) throw new AppError("MEDIA_TOO_LARGE", "媒体文件超过 4GB，未开始上传。", {}, 413);
  const directory = path.join(VIDEO_CACHE_DIR, note.id);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `${mediaCacheStem(note)}.${process.pid}.uploading`);
  const target = path.join(directory, `${mediaCacheStem(note)}-uploaded${extension}`);
  const handle = await fsp.open(temporary, "w", 0o600);
  let bytes = 0;
  let writeError = null;
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new AppError("MEDIA_TOO_LARGE", "媒体文件超过 4GB，上传已停止。", {}, 413);
      await handle.write(chunk);
    }
  } catch (error) {
    writeError = error;
  } finally {
    await handle.close();
  }
  if (writeError) {
    fs.rmSync(temporary, { force: true });
    throw writeError;
  }
  if (!bytes) {
    fs.rmSync(temporary, { force: true });
    throw new AppError("MEDIA_EMPTY", "上传的媒体文件为空。", {}, 422);
  }
  fs.renameSync(temporary, target);
  note.media = {
    ...(note.media || {}),
    status: "ready",
    videoPath: storedDataPath(target),
    mimeType: mimeType(target),
    bytes,
    source: "user_upload",
    originalName: safeString(req.headers["x-file-name"]).slice(0, 240),
    updatedAt: now()
  };
  const saved = saveNote(note);
  appendOperationEvent(note.id, "local_media_uploaded", { bytes, mimeType: note.media.mimeType, originalName: note.media.originalName });
  return saved;
}

function serveNoteMedia(note, req, res) {
  const filePath = resolveCachedMedia(note);
  if (!filePath) {
    text(res, 404, "Media not found");
    return;
  }
  const stats = fs.statSync(filePath);
  const range = safeString(req.headers.range);
  const commonHeaders = {
    "Content-Type": note.media?.mimeType || mimeType(filePath),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600"
  };
  if (!range) {
    res.writeHead(200, { ...commonHeaders, "Content-Length": stats.size });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    res.writeHead(416, { "Content-Range": `bytes */${stats.size}` });
    res.end();
    return;
  }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), stats.size - 1) : stats.size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= stats.size) {
    res.writeHead(416, { "Content-Range": `bytes */${stats.size}` });
    res.end();
    return;
  }
  res.writeHead(206, {
    ...commonHeaders,
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${stats.size}`
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function handleError(res, error) {
  const statusCode = error.statusCode || (error.code === "NO_SUBTITLE" ? 422 : 500);
  json(res, statusCode, {
    ok: false,
    code: error.code || "UNKNOWN",
    message: error.message || "发生未知错误。",
    details: error.details || {}
  });
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (pathname === "/api/subtitles" && ["GET", "POST"].includes(req.method)) {
    const body = req.method === "POST" ? await readJsonBody(req) : {};
    const input = body.url || requestUrl.searchParams.get("url");
    if (!input) throw new AppError("MISSING_URL", "请先粘贴 B站或抖音视频链接。", {}, 400);
    return json(res, 200, await loadSubtitles(input, body));
  }

  if (pathname === "/api/notes" && req.method === "GET") {
    return json(res, 200, { ok: true, notes: getVisibleNotes(requestUrl.searchParams.get("q"), requestUrl.searchParams.get("tag"), requestUrl.searchParams.get("includeDeleted") === "1") });
  }

  if (pathname === "/api/notes" && req.method === "POST") {
    const body = await readJsonBody(req);
    const input = safeString(body.url);
    if (!input) throw new AppError("MISSING_URL", "请先粘贴 B站或抖音视频链接。", {}, 400);
    const provider = detectVideoProvider(input);
    let source = null;
    let identifier = "";
    if (provider === "bilibili") {
      identifier = await resolveBvid(input);
    } else {
      source = await loadDouyinSource(input, body);
      identifier = sourceId(source);
    }
    const existing = findNoteBySource(provider, identifier);
    if (existing) {
      const wasDeleted = Boolean(existing.deletedAt);
      if (existing.deletedAt) {
        delete existing.deletedAt;
        existing.status = existing.processing?.subtitle === "ready" ? "ready" : "waiting_asr";
      }
      // 同一个 BVID 仍然只保留一条笔记；如果用户这次带了 SESSDATA，
      // 对之前没有拿到字幕的笔记做一次原地刷新，而不是直接返回旧缓存。
      if (provider === "bilibili" && safeString(body.sessdata) && existing.processing?.subtitle !== "ready") {
        const refreshed = await refreshNoteSubtitles(existing, input, body);
        appendOperationEvent(existing.id, "subtitle_refreshed", {
          authUsed: refreshed.result.authUsed,
          subtitleStatus: refreshed.result.subtitleStatus,
          segmentCount: refreshed.result.stats.segmentCount,
          preserved: Boolean(refreshed.preserved)
        });
        return json(res, 200, {
          ok: true,
          created: false,
          refreshed: true,
          preserved: refreshed.preserved || false,
          note: refreshed.note,
          subtitleStatus: refreshed.result.subtitleStatus,
          authUsed: refreshed.result.authUsed,
          message: refreshed.result.stats.segmentCount
            ? `已重新获取 ${refreshed.result.stats.segmentCount} 段字幕。`
            : refreshed.result.loginRequired
              ? "B站仍提示字幕需要登录，请检查 SESSDATA 是否为当前账号的有效值。"
              : "这条视频目前没有拿到可用字幕或 AI 字幕。"
        });
      }
      if (provider === "douyin" && source) {
        const pages = source.pages.map((page) => ({ page: page.page, cid: page.cid, part: page.part, duration: page.duration }));
        existing.source = { ...existing.source, ...clone(source.source), pages };
        existing.schemaVersion = Math.max(2, Number(existing.schemaVersion || 1));
      }
      saveNote(existing);
      appendOperationEvent(existing.id, wasDeleted ? "note_restored_by_reopen" : "note_reopened", { provider, sourceId: sourceId(existing) });
      return json(res, 200, { ok: true, created: false, note: existing, message: "这个视频已经存在于笔记中。" });
    }
    if (!source) source = await loadSource(input, body);
    const note = buildNoteFromSource(source, {
      tags: body.tags,
      engine: body.engine,
      provider: body.provider,
      model: body.model
    });
    saveNote(note);
    appendOperationEvent(note.id, "note_created", {
      provider: sourceProvider(note),
      sourceId: sourceId(note),
      authUsed: source.authUsed,
      subtitleStatus: source.subtitleStatus,
      segmentCount: source.stats.segmentCount
    });
    return json(res, 201, { ok: true, created: true, note });
  }

  const noteMatch = pathname.match(/^\/api\/notes\/(note_[a-z0-9]+)$/i);
  const noteCoverMatch = pathname.match(/^\/api\/notes\/(note_[a-z0-9]+)\/cover$/i);
  const noteActionMatch = pathname.match(/^\/api\/notes\/(note_[a-z0-9]+)\/(analysis|record|restore|export\.md|subtitles|asr|diarization|speakers|logs|tasks|media)$/i);
  const knowledgeActionMatch = pathname.match(/^\/api\/notes\/(note_[a-z0-9]+)\/knowledge\/(preview|materials|synthesize)$/i);
  const taskMatch = pathname.match(/^\/api\/tasks\/(task_[a-z0-9]+)(?:\/(retry))?$/i);
  const codexPreviewMatch = pathname === "/api/codex/file-tasks/preview";
  const codexTaskMatch = pathname.match(/^\/api\/codex\/file-tasks\/(task_[a-z0-9]+)(?:\/(confirm))?$/i);

  if (noteCoverMatch && req.method === "GET") {
    await serveNoteCover(loadNote(noteCoverMatch[1]), res);
    return;
  }

  if (knowledgeActionMatch && req.method === "POST") {
    const note = loadNote(knowledgeActionMatch[1]);
    const action = knowledgeActionMatch[2];
    const body = await readJsonBody(req);
    if (action === "preview") {
      return json(res, 200, { ok: true, preview: previewKnowledgeMaterials(note, body) });
    }
    if (action === "materials") {
      const plan = analysisRequestFromBody(note, { ...body, operation: "knowledge_extract", engine: "api" });
      // 已完成的知识资料任务不自动复用：用户在 BLOCKED 后必须能真正重新整理，而不是拿回旧包。
      const reusable = listAnalysisTasks(note.id).find((task) => task.meta?.inputFingerprint === plan.fingerprint && ["queued", "running"].includes(task.status));
      if (reusable) return json(res, reusable.status === "completed" ? 200 : 202, { ok: true, created: false, reused: true, task: reusable });
      const { task } = createAnalysisTask(note, body, plan);
      startTask(task, (progress) => executeAnalysis(task, progress).then((result) => {
        progress(100, "API 资料已 100% 完成，Codex 已解锁");
        return result;
      }));
      return json(res, 202, { ok: true, created: true, task });
    }
    const active = listAnalysisTasks(note.id).find((task) => task.meta?.operation === "knowledge_synthesize" && ["queued", "running"].includes(task.status));
    if (active) return json(res, 202, { ok: true, created: false, reused: true, task: active });
    const task = createKnowledgeSynthesisTask(note, body);
    startTask(task, (progress) => executeAnalysis(task, progress).then((result) => {
      progress(100, result.auditStatus === "PASS" ? "Codex 核查通过，总输出已生成" : "Codex 已阻止合成并列出问题");
      return result;
    }));
    return json(res, 202, { ok: true, created: true, task });
  }

  if (noteActionMatch) {
    const note = loadNote(noteActionMatch[1]);
    const action = noteActionMatch[2];
    if (action === "media" && req.method === "GET") {
      serveNoteMedia(note, req, res);
      return;
    }
    if (action === "media" && ["POST", "PUT"].includes(req.method)) {
      const saved = await receiveNoteMedia(note, req);
      return json(res, 201, { ok: true, note: saved, media: { status: saved.media?.status, mimeType: saved.media?.mimeType, bytes: saved.media?.bytes } });
    }
    if (action === "restore" && req.method === "POST") {
      delete note.deletedAt;
      note.status = note.processing?.subtitle === "ready" ? "ready" : "waiting_asr";
      const saved = saveNote(note);
      appendOperationEvent(note.id, "note_restored", { status: saved.status });
      return json(res, 200, { ok: true, note: saved });
    }
    if (action === "record" && req.method === "PUT") {
      const body = await readJsonBody(req);
      const incomingRevision = Number(body.revision || 0);
      if (incomingRevision < Number(note.record?.revision || 0)) {
        appendOperationEvent(note.id, "record_conflict", { incomingRevision, currentRevision: note.record?.revision });
        throw new AppError("STALE_RECORD", "记录已经被更新，请刷新后再保存。", { revision: note.record?.revision }, 409);
      }
      const html = sanitizeHtml(body.html);
      note.record = {
        html,
        plainText: safeString(body.plainText) || htmlToPlainText(html),
        revision: incomingRevision + 1,
        updatedAt: now()
      };
      const saved = saveNote(note);
      appendOperationEvent(note.id, "record_saved", { revision: note.record.revision, plainTextChars: note.record.plainText.length });
      return json(res, 200, { ok: true, record: note.record, note: saved });
    }
    if (action === "export.md" && req.method === "GET") {
      const markdown = buildMarkdown(note);
      const identifier = sourceId(note) || note.id;
      const filename = `${safeSlug(note.title, identifier)}-${identifier}.md`;
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "no-store"
      });
      res.end(markdown);
      appendOperationEvent(note.id, "markdown_exported", { bytes: Buffer.byteLength(markdown), filename });
      return;
    }
    if (action === "logs" && req.method === "GET") {
      return json(res, 200, { ok: true, logs: listGenerationLogs(note.id), operations: listOperationLogs({ noteId: note.id }) });
    }
    if (action === "tasks" && req.method === "GET") {
      const tasks = listNoteTasks(note.id);
      return json(res, 200, {
        ok: true,
        tasks,
        activeTask: tasks.find((task) => ["queued", "running"].includes(task.status)) || null,
        latestTask: tasks[0] || null
      });
    }
    if (action === "subtitles" && req.method === "POST") {
      const body = await readJsonBody(req);
      const refreshed = await refreshNoteSubtitles(note, note.source?.url, body);
      const hasSubtitles = refreshed.result.stats.segmentCount > 0;
      appendOperationEvent(note.id, "subtitle_refreshed", {
        authUsed: refreshed.result.authUsed,
        subtitleStatus: refreshed.result.subtitleStatus,
        segmentCount: refreshed.result.stats.segmentCount,
        preserved: Boolean(refreshed.preserved)
      });
      return json(res, 200, {
        ok: true,
        note: refreshed.note,
        preserved: refreshed.preserved || false,
        subtitleStatus: refreshed.result.subtitleStatus,
        authUsed: refreshed.result.authUsed,
        message: sourceProvider(note) === "douyin"
          ? "抖音视频信息已刷新；原始文字仍需通过本地 ASR 生成。"
          : hasSubtitles
          ? `已重新获取 ${refreshed.result.stats.segmentCount} 段字幕。`
          : refreshed.result.loginRequired
            ? "B站仍提示字幕需要登录，请检查 SESSDATA 是否为当前账号的有效值。"
            : "这条视频目前没有拿到可用字幕或 AI 字幕。"
      });
    }
    if (action === "analysis" && req.method === "POST") {
      const body = await readJsonBody(req);
      const plan = analysisRequestFromBody(note, body);
      if (body.previewOnly === true) {
        const chunks = plan.chunks;
        return json(res, 200, {
          ok: true,
          preview: {
            operation: plan.operation,
            segmentCount: plan.input.segments.length,
            chunkCount: chunks.length,
            apiRequestCount: chunks.filter((chunk) => chunk.status !== "completed").length,
            reusedChunkCount: 0,
            reusedSegmentCount: 0,
            editBlockCount: plan.operation === "polish" ? chunks.reduce((sum, chunk) => sum + Number(chunk.blockCount || 0), 0) : 0,
            inputChars: plan.inputChars,
            inputTokens: plan.inputTokens,
            expectedOutputTokens: plan.expectedOutputTokens
          }
        });
      }
      const reusable = findReusableAnalysisTask(note.id, plan.fingerprint);
      if (reusable) {
        return json(res, reusable.status === "completed" ? 200 : 202, { ok: true, created: false, reused: true, task: reusable });
      }
      const { task } = createAnalysisTask(note, body, plan);
      startTask(task, (progress) => executeAnalysis(task, progress).then((result) => {
        progress(100, "AI 结果已保存");
        return result;
      }));
      return json(res, 202, { ok: true, created: true, task });
    }
    if (action === "asr" && req.method === "POST") {
      const existing = activeTaskFor(note.id, "asr");
      if (existing) return json(res, 202, { ok: true, created: false, reused: true, task: existing });
      if (activeTaskFor(note.id, "diarization")) throw new AppError("LOCAL_AUDIO_TASK_BUSY", "当前笔记正在做说话人识别，请完成后再启动 ASR。", {}, 409);
      const body = await readJsonBody(req);
      const config = asrRuntimeConfig();
      assertAsrReady(config);
      const { task, credentials } = createAsrTask(note, body);
      note.processing = { ...(note.processing || {}), asr: "running" };
      note.asr = { ...(note.asr || {}), status: "running", taskId: task.id, pageIndex: task.meta.pageIndex, startedAt: now() };
      saveNote(note);
      startTask(task, (progress) => executeAsrTask(task, credentials, progress));
      return json(res, 202, { ok: true, created: true, task });
    }
    if (action === "diarization" && req.method === "POST") {
      const existing = activeTaskFor(note.id, "diarization");
      if (existing) return json(res, 202, { ok: true, created: false, reused: true, task: existing });
      if (activeTaskFor(note.id, "asr")) throw new AppError("LOCAL_AUDIO_TASK_BUSY", "当前笔记正在做本地 ASR，请完成后再启动说话人识别。", {}, 409);
      const body = await readJsonBody(req);
      const config = asrRuntimeConfig();
      assertAsrReady(config);
      const { task, credentials } = createDiarizationTask(note, body);
      note.processing = { ...(note.processing || {}), diarization: "running" };
      note.speaker = { ...(note.speaker || {}), status: "running", taskId: task.id, pageIndex: task.meta.pageIndex, startedAt: now() };
      saveNote(note);
      startTask(task, (progress) => executeDiarizationTask(task, credentials, progress));
      return json(res, 202, { ok: true, created: true, task });
    }
    if (action === "speakers" && req.method === "PATCH") {
      const body = await readJsonBody(req);
      const speakerId = safeString(body.speakerId);
      const label = safeString(body.label).slice(0, 60);
      const known = new Set([...(note.speaker?.segments || []).map((segment) => safeString(segment.speakerId)), "speaker_unknown", "speaker_multiple"]);
      if (!known.has(speakerId)) throw new AppError("SPEAKER_NOT_FOUND", "这条笔记里没有这个说话人编号。", { speakerId }, 404);
      if (!label) throw new AppError("SPEAKER_LABEL_EMPTY", "说话人名称不能为空。", {}, 422);
      note.speaker = { ...(note.speaker || {}), labels: { ...(note.speaker?.labels || {}), [speakerId]: label } };
      invalidateKnowledge(note, "说话人名称已更新");
      const saved = saveNote(note);
      appendOperationEvent(note.id, "speaker_label_updated", { speakerId, label });
      return json(res, 200, { ok: true, note: saved, labels: saved.speaker.labels });
    }
  }

  if (noteMatch) {
    const note = loadNote(noteMatch[1]);
    if (req.method === "GET") {
      note.lastOpenedAt = now();
      note.progress = Math.max(0, Math.min(100, Number(note.progress || 0)));
      saveNote(note);
      appendOperationEvent(note.id, "note_opened", { status: note.status });
      return json(res, 200, { ok: true, note });
    }
    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      const saved = updateNoteMeta(note, body);
      const changedFields = ["title", "tags", "pinned", "progress", "processingEngine", "processingProvider", "processingModel"]
        .filter((field) => body[field] !== undefined);
      appendOperationEvent(note.id, "note_metadata_updated", { changedFields, tagCount: saved.tags?.length || 0, pinned: saved.pinned, progress: saved.progress });
      return json(res, 200, { ok: true, note: saved });
    }
    if (req.method === "DELETE") {
      note.deletedAt = now();
      note.status = "deleted";
      const saved = saveNote(note);
      appendOperationEvent(note.id, "note_soft_deleted", { deletedAt: saved.deletedAt });
      return json(res, 200, { ok: true, note: saved });
    }
  }

  if (taskMatch) {
    if (req.method === "GET" && !taskMatch[2]) return json(res, 200, { ok: true, task: loadTask(taskMatch[1]) });
    if (req.method === "POST" && taskMatch[2] === "retry") {
      const task = prepareAnalysisTaskRetry(loadTask(taskMatch[1]));
      startTask(task, (progress) => executeAnalysis(task, progress).then((result) => {
        progress(100, "失败分块已重试并保存");
        return result;
      }));
      return json(res, 202, { ok: true, task });
    }
  }

  if (pathname === "/api/logs" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      operations: listOperationLogs({
        noteId: safeString(requestUrl.searchParams.get("noteId")),
        from: safeString(requestUrl.searchParams.get("from")),
        to: safeString(requestUrl.searchParams.get("to")),
        limit: Number(requestUrl.searchParams.get("limit") || 200)
      })
    });
  }

  if (pathname === "/api/asr/status" && req.method === "GET") {
    return json(res, 200, { ok: true, diagnostics: getAsrDiagnostics() });
  }

  if (pathname === "/api/settings" && req.method === "GET") {
    return json(res, 200, { ok: true, settings: loadSettings() });
  }

  if (pathname === "/api/settings" && req.method === "PATCH") {
    const body = await readJsonBody(req);
    return json(res, 200, { ok: true, settings: saveSettings({ ...loadSettings(), ...body }) });
  }

  if (pathname === "/api/ai/engines" && req.method === "GET") {
    return json(res, 200, { ok: true, engines: await loadAiEngines() });
  }

  if (codexPreviewMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    const note = loadNote(safeString(body.noteId));
    const task = createCodexFilePreview(note, safeString(body.operation || "write_markdown"));
    appendOperationEvent(note.id, "obsidian_preview_created", {
      taskId: task.id,
      operation: task.plan?.operation,
      action: task.plan?.action,
      bytes: task.plan?.bytes,
      targetPath: task.plan?.targetPath
    });
    return json(res, 202, { ok: true, task });
  }

  if (codexTaskMatch) {
    const task = loadTask(codexTaskMatch[1]);
    if (req.method === "GET") return json(res, 200, { ok: true, task });
    if (req.method === "POST" && codexTaskMatch[2] === "confirm") {
      if (task.status !== "awaiting_confirmation") throw new AppError("CODEX_TASK_NOT_WAITING", "这个文件任务已经处理过了。", {}, 409);
      appendOperationEvent(task.noteId, "obsidian_write_confirmed", { taskId: task.id, operation: task.plan?.operation });
      task.status = "running";
      task.message = "正在写入允许的文件";
      saveTask(task);
      try {
        task.result = executeCodexFileTask(task);
        task.status = "completed";
        task.progress = 100;
        task.message = "文件操作完成";
        appendOperationEvent(task.noteId, "obsidian_write_succeeded", { taskId: task.id, operation: task.plan?.operation, result: task.result });
      } catch (error) {
        task.status = "failed";
        task.error = { code: error.code || "CODEX_FILE_FAILED", message: error.message };
        appendOperationEvent(task.noteId, "obsidian_write_failed", { taskId: task.id, operation: task.plan?.operation, code: task.error.code, message: task.error.message });
      }
      saveTask(task);
      return json(res, 200, { ok: task.status === "completed", task });
    }
  }

  serveStatic(req, res, pathname);
}

ensureDirectories();
markInterruptedTasks();
cleanupStaleAsrTempDirectories();
migrateLegacyGenerationLogs();

function createHttpServer() {
  return http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (error) {
      handleError(res, error);
    }
  });
}

if (require.main === module) {
  const server = createHttpServer();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Video Note Workspace is running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = {
  AI_CHUNK_MAX_CHARS,
  AI_CHUNK_TEXT_MAX_CHARS,
  appendOperationEvent,
  assessPolishQuality,
  assertKnowledgeMaterialReady,
  buildAnalysisInput,
  buildKnowledgeInput,
  mergePolishedParagraphSegments,
  buildMarkdown,
  buildNoteFromSource,
  buildGlobalStructureMessage,
  buildSpeakerTranscript,
  createAnalysisTask,
  analysisRequestFromBody,
  createAnalysisChunks,
  createPolishBlocks,
  createKnowledgeChunks,
  createKnowledgeSynthesisTask,
  codexCliExecutable,
  createAsrTask,
  createDiarizationTask,
  createHttpServer,
  detectVideoProvider,
  executeAnalysis,
  executeAsrTask,
  executeDiarizationTask,
  findReusableAnalysisTask,
  getAsrDiagnostics,
  loadDouyinSource,
  listOperationLogs,
  listGenerationLogs,
  loadNote,
  loadTask,
  normalizeAlignedSegments,
  normalizePolishParagraphs,
  normalizePolishBlockText,
  normalizeCodexSynthesis,
  normalizeKnowledgeChunkResponse,
  mapTranscriptToSpeakers,
  mergeSpeakerTranscriptSegments,
  parseJsonResponse,
  previewCodexFileTask,
  previewKnowledgeMaterials,
  receiveNoteMedia,
  restoreInterruptedKnowledgeState,
  redactLogText,
  sanitizeMindmapTree,
  sanitizeOutlineTree,
  summarizeCodexFailure,
  saveAsrTranscript,
  saveDiarizationResult,
  saveAlignmentPartial,
  saveNote,
  serveNoteMedia,
  sourceId,
  sourceKey,
  sourceProvider,
  prepareAnalysisTaskRetry,
  readCanvasLlmStream,
  runTask,
  setAiCallOverrideForTests: (handler) => { aiCallOverride = typeof handler === "function" ? handler : null; },
  setYtDlpMetadataOverrideForTests: (handler) => { ytDlpMetadataOverride = typeof handler === "function" ? handler : null; }
};
