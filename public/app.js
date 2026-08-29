const state = {
  notes: [],
  note: null,
  view: "library",
  pageIndex: 0,
  trackIndex: 0,
  transcriptMode: "original",
  leftTab: "mindmap",
  analysisPageScope: "current",
  analysisTrackScope: "current",
  transcriptSearch: "",
  speakerFilter: "all",
  notesSearch: "",
  notesFilter: "all",
  activeTaskId: "",
  activeSegmentId: "",
  pendingSeekSeconds: null,
  analysisStatuses: {},
  generationTimer: null,
  subtitleRefreshing: false,
  recordSaveTimer: null,
  recordSaving: false,
  aiEngines: null,
  asrDiagnostics: null,
  settings: null,
  generationLogs: [],
  generationLogRefreshAt: 0,
  operationLogs: [],
  operationLogScope: "all",
  knowledgeDetailsOpen: false,
  knowledgeTranscriptMode: "polished",
  knowledgePreflightError: null,
  knowledgeTask: null,
  knowledgeTimer: null,
  toastTimer: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const libraryView = $("#library-view");
const noteView = $("#note-view");
const noteForm = $("#note-form");
const urlInput = $("#url-input");
const sessdataInput = $("#sessdata-input");
const douyinBrowserCookies = $("#douyin-browser-cookies");
const createEngineSelect = $("#create-engine-select");
const createTagsInput = $("#create-tags-input");
const createNoteButton = $("#create-note-button");
const createStatus = $("#create-status");
const notesList = $("#notes-list");
const notesEmpty = $("#notes-empty");
const notesLoading = $("#notes-loading");
const notesSearch = $("#notes-search");
const notesMeta = $("#notes-meta");
const navNoteCount = $("#nav-note-count");
const navPendingCount = $("#nav-pending-count");
const navTrashCount = $("#nav-trash-count");
const noteTitle = $("#note-title");
const noteSourceMeta = $("#note-source-meta");
const noteProcessingStatus = $("#note-processing-status");
const noteOriginalLink = $("#note-original-link");
const noteTags = $("#note-tags");
const noteEngineSelect = $("#note-engine-select");
const noteProviderSelect = $("#note-provider-select");
const noteModelSelect = $("#note-model-select");
const aiEngineStatus = $("#ai-engine-status");
const knowledgeStatusBadge = $("#knowledge-status-badge");
const knowledgeTranscriptMode = $("#knowledge-transcript-mode");
const knowledgeApiButton = $("#knowledge-api-button");
const knowledgeApiLabel = $("#knowledge-api-label");
const knowledgeApiButtonStatus = $("#knowledge-api-button-status");
const knowledgeCodexButton = $("#knowledge-codex-button");
const knowledgeReadinessButton = $("#knowledge-readiness-button");
const knowledgeReadinessLabel = $("#knowledge-readiness-label");
const knowledgeIntegrityPanel = $("#knowledge-integrity-panel");
const knowledgeIntegrityTitle = $("#knowledge-integrity-title");
const knowledgeIntegrityPercent = $("#knowledge-integrity-percent");
const knowledgeIntegritySummary = $("#knowledge-integrity-summary");
const knowledgeChecks = $("#knowledge-checks");
const knowledgeTaskProgress = $("#knowledge-task-progress");
const knowledgeTaskProgressMark = $("#knowledge-task-progress-mark");
const knowledgeTaskProgressTitle = $("#knowledge-task-progress-title");
const knowledgeTaskProgressMessage = $("#knowledge-task-progress-message");
const knowledgeTaskProgressPercent = $("#knowledge-task-progress-percent");
const knowledgeTaskProgressBar = $("#knowledge-task-progress-bar");
const knowledgeTaskProgressMeta = $("#knowledge-task-progress-meta");
const pageSelect = $("#page-select");
const trackSelect = $("#track-select");
const analysisPageScopeSelect = $("#analysis-page-scope");
const analysisTrackScopeSelect = $("#analysis-track-scope");
const analysisScopeSummary = $("#analysis-scope-summary");
const refreshSubtitlesButton = $("#refresh-subtitles-button");
const asrButton = $("#asr-button");
const asrStatus = $("#asr-status");
const diarizationButton = $("#diarization-button");
const diarizationStatus = $("#diarization-status");
const transcriptSearch = $("#transcript-search");
const transcriptMeta = $("#transcript-meta");
const transcriptList = $("#transcript-list");
const transcriptState = $("#transcript-state");
const segmentCount = $("#segment-count");
const speakerLabels = $("#speaker-labels");
const speakerFilterControl = $("#speaker-filter-control");
const speakerFilter = $("#speaker-filter");
const leftContent = $("#left-content");
const playerFrame = $("#player-frame");
const localPlayer = $("#local-player");
const playerFallback = $("#player-fallback");
const playerFallbackCopy = $("#player-fallback-copy");
const playerFallbackLink = $("#player-fallback-link");
const mediaUploadInput = $("#media-upload-input");
const playerOpenLink = $("#player-open-link");
const playerTitle = $("#player-title");
const playerTime = $("#player-time");
const recordEditor = $("#record-editor");
const recordStatus = $("#record-status");
const generationLogDialog = $("#generation-log-dialog");
const generationLogList = $("#generation-log-list");
const activityLogDialog = $("#activity-log-dialog");
const activityLogList = $("#activity-log-list");
const mindmapDialog = $("#mindmap-dialog");
const mindmapDialogContent = $("#mindmap-dialog-content");
const settingsDialog = $("#settings-dialog");
const settingsForm = $("#settings-form");
const settingsMessage = $("#settings-message");
const toast = $("#toast");

let noteTitleMeasure;
let noteTitleFitFrame = 0;
let noteTitleResizeObserver;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getSourceProvider(value = state.note) {
  const source = value?.source || value || {};
  if (source.provider) return String(source.provider).toLowerCase();
  if (source.bvid) return "bilibili";
  return /douyin\.com/i.test(String(source.url || "")) ? "douyin" : "bilibili";
}

function getSourceId(value = state.note) {
  const source = value?.source || value || {};
  return String(source.sourceId || source.videoId || source.itemId || source.bvid || "");
}

function sourcePlatformLabel(value = state.note) {
  return getSourceProvider(value) === "douyin" ? "抖音" : "B站";
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join(":")
    : [minutes, secs].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatDate(value) {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function showToast(message, tone = "normal") {
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.add("visible");
  if (state.toastTimer) window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3400);
}

const ANALYSIS_BUTTONS = {
  polish: "#polish-button",
  outline: "#outline-button",
  mindmap: "#mindmap-button",
  structure: "#structure-button"
};

function formatElapsed(milliseconds) {
  const total = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function operationResultReady(operation) {
  if (!state.note) return false;
  if (operation === "polish") return ["ready", "partial"].includes(state.note.transcript?.polished?.status);
  if (operation === "outline") return ["ready", "partial"].includes(state.note.outline?.status) && Boolean(state.note.outline?.tree);
  if (operation === "mindmap") return ["ready", "partial"].includes(state.note.mindmap?.status) && Boolean(state.note.mindmap?.tree);
  if (operation === "structure") return operationResultReady("outline") && operationResultReady("mindmap");
  return false;
}

function getGenerationStatus(operation) {
  const runtimeStatus = state.analysisStatuses[operation];
  if (runtimeStatus?.status === "running" || runtimeStatus?.status === "failed") return runtimeStatus;
  if (operationResultReady(operation)) {
    const target = operation === "polish" ? state.note.transcript?.polished
      : operation === "outline" ? state.note.outline
        : operation === "mindmap" ? state.note.mindmap : null;
    return { status: target?.status === "partial" ? "partial" : "completed", updatedAt: target?.generatedAt, scope: target?.scope };
  }
  return runtimeStatus || { status: "not_generated" };
}

function renderAnalysisButtonStates() {
  const labels = {
    not_generated: "未生成",
    running: "生成中",
    completed: "已生成",
    partial: "部分完成",
    failed: "生成失败"
  };
  Object.entries(ANALYSIS_BUTTONS).forEach(([operation, selector]) => {
    const button = $(selector);
    if (!button) return;
    const badge = button.querySelector("[data-generation-status]");
    const status = getGenerationStatus(operation);
    const statusKey = ["not_generated", "running", "completed", "partial", "failed"].includes(status.status) ? status.status : "not_generated";
    const text = statusKey === "running"
      ? `${labels.running} ${formatElapsed(Date.now() - Number(status.startedAt || Date.now()))}`
      : ["completed", "partial"].includes(statusKey) && status.updatedAt
        ? `${labels[statusKey]} ${formatDate(status.updatedAt)}`
        : labels[statusKey];
    button.dataset.generationStatus = statusKey;
    if (badge) {
      badge.dataset.generationStatus = statusKey;
      badge.textContent = text;
    }
    const scope = status.scope || {};
    button.title = ["completed", "partial"].includes(statusKey)
      ? `最近生成：${formatDate(status.updatedAt)} · ${scope.pageScope === "all" ? "全部 P" : "当前 P"} / ${scope.trackScope === "all" ? "全部轨道" : "当前轨道"}`
      : button.getAttribute("data-default-title") || button.title;
  });
  const hasRunning = Object.keys(ANALYSIS_BUTTONS).some((operation) => getGenerationStatus(operation).status === "running");
  if (hasRunning && !state.generationTimer) {
    state.generationTimer = window.setInterval(renderAnalysisButtonStates, 1000);
  } else if (!hasRunning && state.generationTimer) {
    window.clearInterval(state.generationTimer);
    state.generationTimer = null;
  }
}

function setGenerationStatus(operation, status, extra = {}) {
  state.analysisStatuses[operation] = { status, ...extra };
  renderAnalysisButtonStates();
}

function generationLogStartedAt(log) {
  const started = (log.events || []).find((event) => event.event === "started");
  return Date.parse(started?.createdAt || log.createdAt || "") || Date.now();
}

function applyGenerationLogStatuses(logs) {
  const next = {};
  (logs || []).forEach((log) => {
    const operation = String(log.operation || "");
    if (!operation || next[operation]) return;
    const partial = String(log.error?.code || "").includes("PARTIAL") || Number(log.metrics?.completedChunkCount || 0) > 0 && Number(log.metrics?.failedChunkCount || 0) > 0;
    const status = log.status === "completed"
      ? "completed"
      : partial
        ? "partial"
      : ["failed", "crashed", "interrupted"].includes(log.status)
        ? "failed"
        : "running";
    next[operation] = { status, startedAt: generationLogStartedAt(log), taskId: log.taskId || "", updatedAt: log.updatedAt || log.createdAt, scope: { pageScope: log.pageScope, trackScope: log.trackScope }, metrics: log.metrics || {} };
    if (operation === "structure" && status === "running") {
      next.outline ||= { status, startedAt: generationLogStartedAt(log), taskId: log.taskId || "" };
      next.mindmap ||= { status, startedAt: generationLogStartedAt(log), taskId: log.taskId || "" };
    }
  });
  state.analysisStatuses = next;
  renderAnalysisButtonStates();
}

async function refreshGenerationStatuses() {
  if (!state.note) return;
  try {
    const payload = await api(`/api/notes/${state.note.id}/logs`);
    state.generationLogs = payload.logs || [];
    applyGenerationLogStatuses(state.generationLogs);
  } catch {
    renderAnalysisButtonStates();
  }
}

function showTaskProgress(task) {
  if (!task) return;
  syncKnowledgeTask(task);
  const metrics = task.metrics || {};
  const isLocalMedia = ["asr", "diarization"].includes(task.type);
  transcriptState.hidden = false;
  transcriptState.innerHTML = `<div class="state-mark loading-state-mark">◌</div><strong>正在处理 ${escapeHtml(operationLabel(task.meta?.operation))}</strong><p id="task-progress-copy">${escapeHtml(task.message || "任务正在执行")} · ${Number(task.progress || 0)}%${isLocalMedia ? ` · 阶段 ${escapeHtml(task.meta?.stage || "准备")}` : ` · 分块 ${Number(metrics.completedChunkCount || 0)}/${Number(metrics.chunkCount || 0)}`}</p>`;
}

function syncKnowledgeTask(task, statusOverride = "") {
  const operation = String(task?.meta?.operation || "");
  if (!["knowledge_extract", "knowledge_synthesize"].includes(operation)) return;
  state.knowledgeTask = {
    operation,
    status: statusOverride || task.status || "queued",
    taskId: task.id || "",
    startedAt: Date.parse(task.startedAt || task.createdAt || "") || state.knowledgeTask?.startedAt || Date.now(),
    progress: Math.max(0, Math.min(100, Number(task.progress || 0))),
    message: task.error?.message || task.message || "任务正在执行",
    metrics: { ...(task.metrics || {}) },
    error: task.error || null
  };
}

async function refreshNoteTasks() {
  if (!state.note) return;
  try {
    const payload = await api(`/api/notes/${state.note.id}/tasks`);
    const active = payload.activeTask;
    if (!active || state.activeTaskId === active.id) return;
    state.activeTaskId = active.id;
    if (active.type === "analysis") setGenerationStatus(active.meta?.operation, "running", { startedAt: Date.parse(active.startedAt || active.createdAt) || Date.now(), taskId: active.id, scope: { pageScope: active.meta?.pageScope, trackScope: active.meta?.trackScope } });
    if (active.type === "analysis" && active.meta?.operation === "structure") {
      setGenerationStatus("outline", active.parts?.outline?.status === "completed" ? "completed" : "running", { taskId: active.id });
      setGenerationStatus("mindmap", active.parts?.mindmap?.status === "completed" ? "completed" : "running", { taskId: active.id });
    }
    showTaskProgress(active);
    updateAIButtons();
    pollTask(active.id).catch((error) => {
      state.activeTaskId = "";
      showToast(error.message, "error");
      updateAIButtons();
    });
  } catch {
    // 任务恢复失败不阻断笔记本身；生成日志仍可用于人工查看。
  }
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
    });
  } catch (cause) {
    const error = new Error("无法连接视频笔记后端。请确认项目仍在运行，然后刷新页面重试。");
    error.code = "VIDEO_NOTE_BACKEND_UNREACHABLE";
    error.details = { path, cause: cause?.message || "network_error" };
    throw error;
  }
  const rawBody = await response.text();
  let payload = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    payload = {};
  }
  if (!response.ok || payload.ok === false) {
    const knowledgeRouteMissing = response.status === 404 && path.includes("/knowledge/") && !payload.code;
    const message = knowledgeRouteMissing
      ? "知识整理接口还没有加载。请重启视频笔记服务并刷新页面，不需要重启 3001 AI 画布。"
      : payload.message || payload.detail || `视频笔记后端请求失败（HTTP ${response.status}）。`;
    const error = new Error(message);
    error.code = payload.code || (knowledgeRouteMissing ? "KNOWLEDGE_ROUTE_NOT_LOADED" : "REQUEST_FAILED");
    error.details = { ...(payload.details || {}), httpStatus: response.status, path };
    error.status = response.status;
    throw error;
  }
  return payload;
}

function setCreateLoading(loading, message = "正在读取视频来源") {
  createNoteButton.disabled = loading;
  createNoteButton.querySelector(".button-label").textContent = loading ? "创建中…" : "创建笔记";
  createStatus.innerHTML = `<span class="status-ring ${loading ? "busy" : ""}"></span> ${escapeHtml(message)}`;
}

function setView(view) {
  state.view = view;
  libraryView.hidden = view !== "library";
  noteView.hidden = view !== "note";
  document.body.dataset.view = view;
}

function getNoteTitleMeasure() {
  if (noteTitleMeasure) return noteTitleMeasure;
  noteTitleMeasure = document.createElement("span");
  Object.assign(noteTitleMeasure.style, {
    position: "absolute",
    left: "-10000px",
    top: "-10000px",
    visibility: "hidden",
    whiteSpace: "nowrap",
    pointerEvents: "none"
  });
  document.body.append(noteTitleMeasure);
  return noteTitleMeasure;
}

function measureNoteTitleWidth(value, fontSize, styles) {
  const measure = getNoteTitleMeasure();
  measure.textContent = value || " ";
  measure.style.fontFamily = styles.fontFamily;
  measure.style.fontSize = `${fontSize}px`;
  measure.style.fontStyle = styles.fontStyle;
  measure.style.fontWeight = styles.fontWeight;
  measure.style.letterSpacing = styles.letterSpacing;
  return measure.getBoundingClientRect().width;
}

function resizeNoteTitle() {
  if (!state.note || noteView.hidden || !noteTitle) return;
  noteTitle.style.height = "auto";
  noteTitle.style.height = `${noteTitle.scrollHeight}px`;
}

function fitNoteTitle() {
  if (!state.note || noteView.hidden || !noteTitle) return;
  const value = noteTitle.value;
  noteTitle.style.fontSize = "";
  const styles = getComputedStyle(noteTitle);
  const maxFontSize = Number.parseFloat(styles.fontSize);
  const minFontSize = Math.min(maxFontSize, 16);
  const availableWidth = noteTitle.clientWidth;
  if (!value || !availableWidth || !Number.isFinite(maxFontSize)) {
    resizeNoteTitle();
    return;
  }

  let fontSize = maxFontSize;
  if (measureNoteTitleWidth(value, fontSize, styles) > availableWidth) {
    let low = minFontSize;
    let high = maxFontSize;
    if (measureNoteTitleWidth(value, low, styles) <= availableWidth) {
      for (let step = 0; step < 8; step += 1) {
        const middle = (low + high) / 2;
        if (measureNoteTitleWidth(value, middle, styles) <= availableWidth) low = middle;
        else high = middle;
      }
      fontSize = low;
    } else {
      fontSize = minFontSize;
    }
  }
  noteTitle.style.fontSize = `${Math.round(fontSize * 10) / 10}px`;
  noteTitle.title = value;
  resizeNoteTitle();
}

function scheduleNoteTitleFit() {
  if (noteTitleFitFrame) window.cancelAnimationFrame(noteTitleFitFrame);
  noteTitleFitFrame = window.requestAnimationFrame(() => {
    noteTitleFitFrame = 0;
    fitNoteTitle();
  });
}

function updateUrl(noteId = "") {
  const url = new URL(window.location.href);
  if (noteId) url.searchParams.set("note", noteId);
  else {
    url.searchParams.delete("note");
    url.searchParams.delete("t");
  }
  window.history.replaceState({}, "", url);
}

function isPendingNote(item) {
  if (item.asrStatus === "ready" || item.processing?.asr === "ready") return false;
  return ["waiting_asr", "pending", "missing", "login_required"].includes(item.status) || ["missing", "login_required"].includes(item.subtitleStatus);
}

function renderNotes() {
  const search = state.notesSearch.trim().toLowerCase();
  let visible = state.notes.filter((item) => {
    const deleted = Boolean(item.deletedAt);
    if (state.notesFilter === "deleted") {
      if (!deleted) return false;
    } else if (deleted) return false;
    if (state.notesFilter === "pinned" && !item.pinned) return false;
    if (state.notesFilter === "pending" && !isPendingNote(item)) return false;
    if (!search) return true;
    const text = [item.title, getSourceId(item), sourcePlatformLabel(item), item.author || item.source?.author, ...(item.tags || [])].join(" ").toLowerCase();
    return text.includes(search);
  });

  const activeNotes = state.notes.filter((item) => !item.deletedAt);
  navNoteCount.textContent = String(activeNotes.length);
  navPendingCount.textContent = String(activeNotes.filter(isPendingNote).length);
  navTrashCount.textContent = String(state.notes.filter((item) => item.deletedAt).length);
  notesMeta.textContent = `${visible.length} 条笔记`;
  notesLoading.hidden = true;
  notesEmpty.hidden = visible.length > 0;
  notesList.hidden = visible.length === 0;

  if (!visible.length) {
    if (state.notesFilter === "deleted") {
      notesEmpty.innerHTML = `<span class="empty-symbol">—</span><strong>回收站是空的。</strong><p>软删除的笔记会保留在这里，可随时恢复。</p>`;
    } else if (state.notesFilter === "pending") {
      notesEmpty.innerHTML = `<span class="empty-symbol">✓</span><strong>没有待处理笔记。</strong><p>目前所有保留的笔记都有可用字幕。</p>`;
    } else if (state.notesFilter === "pinned") {
      notesEmpty.innerHTML = `<span class="empty-symbol">☆</span><strong>还没有置顶笔记。</strong><p>点击笔记卡片右侧的星标即可置顶。</p>`;
    } else if (search) {
      notesEmpty.innerHTML = `<span class="empty-symbol">⌕</span><strong>没有匹配的笔记。</strong><p>换一个标题、UP 主、BV 号或标签试试。</p>`;
    } else {
      notesEmpty.innerHTML = `<span class="empty-symbol">—</span><strong>还没有视频笔记。</strong><p>从上面粘贴一个 B站或抖音链接，第一条笔记会从这里开始。</p>`;
    }
    notesList.innerHTML = "";
    return;
  }

  notesList.innerHTML = visible.map((item, index) => {
    const deleted = Boolean(item.deletedAt);
    const statusLabel = deleted ? "已删除" : isPendingNote(item) ? "待处理" : item.aiStatus === "ready" ? "已整理" : "原文已保存";
    const statusClass = deleted ? "deleted" : isPendingNote(item) ? "pending" : item.aiStatus === "ready" ? "ready" : "";
    const tags = (item.tags || []).slice(0, 4).map((tag) => `<span class="note-tag">${escapeHtml(tag)}</span>`).join("");
    const coverUrl = item.cover || item.source?.cover;
    const duration = Number(item.duration || item.source?.duration || 0);
    const author = item.author || item.source?.author;
    const cover = coverUrl
      ? `<img src="/api/notes/${encodeURIComponent(item.id)}/cover" alt="${escapeHtml(item.title)}" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false" /><div class="cover-placeholder" hidden><span>✦</span></div>`
      : `<div class="cover-placeholder"><span>✦</span></div>`;
    const identifier = getSourceId(item);
    const platform = sourcePlatformLabel(item);
    return `
      <article class="note-card ${item.pinned ? "is-pinned" : ""}" data-note-id="${escapeHtml(item.id)}" style="--card-delay:${Math.min(index * 45, 260)}ms">
        <div class="note-card-cover">${cover}<span class="card-duration">${formatTime(duration)}</span></div>
        <div class="note-card-body">
          <div class="note-card-topline"><span class="card-status ${statusClass}"><i></i>${statusLabel}</span><span class="card-date">${deleted ? `删除于 ${formatDate(item.deletedAt)}` : formatDate(item.updatedAt)}</span></div>
          <h3>${escapeHtml(item.title)}</h3>
          <p class="card-author">@ ${escapeHtml(author || (platform === "抖音" ? "未知作者" : "未知UP主"))} <span>·</span> ${escapeHtml(platform)} ${escapeHtml(identifier)}</p>
          <div class="card-bottom"><div class="card-tags">${tags || `<span class="note-tag muted">未分类</span>`}</div><span class="card-progress">${Math.round(Number(item.progress || 0))}%</span></div>
        </div>
        <div class="note-card-actions">${deleted
          ? `<button data-card-action="restore" type="button" title="恢复笔记">恢复</button>`
          : `<button data-card-action="pin" type="button" title="${item.pinned ? "取消置顶" : "置顶"}">${item.pinned ? "★" : "☆"}</button><button data-card-action="delete" type="button" title="删除">×</button>`}</div>
      </article>`;
  }).join("");
}

async function loadNotes() {
  notesLoading.hidden = false;
  notesEmpty.hidden = true;
  try {
    const payload = await api("/api/notes?includeDeleted=1");
    state.notes = payload.notes || [];
    renderNotes();
  } catch (error) {
    notesLoading.hidden = true;
    notesEmpty.hidden = false;
    notesEmpty.innerHTML = `<span class="empty-symbol">!</span><strong>笔记读取失败。</strong><p>${escapeHtml(error.message)}</p>`;
    showToast(error.message, "error");
  }
}

async function createNote(event) {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;
  setCreateLoading(true);
  const sessdata = sessdataInput.value.trim();
  const browserCookies = douyinBrowserCookies.checked ? "chrome" : "";
  try {
    const tags = createTagsInput.value.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean);
    const payload = await api("/api/notes", {
      method: "POST",
      body: JSON.stringify({ url, sessdata, browserCookies, tags, engine: createEngineSelect.value })
    });
    state.notes = [payload.note, ...state.notes.filter((item) => item.id !== payload.note.id).map((item) => item)];
    renderNotes();
    urlInput.value = "";
    createTagsInput.value = "";
    setCreateLoading(false, payload.created ? "笔记已创建" : "已打开已有笔记");
    await openNote(payload.note.id);
  } catch (error) {
    setCreateLoading(false, "创建失败");
    showToast(error.message, "error");
  } finally {
    // SESSDATA 只参与本次请求，不留在页面表单里。
    sessdataInput.value = "";
    douyinBrowserCookies.checked = false;
  }
}

async function refreshSubtitles() {
  if (!state.note || state.subtitleRefreshing) return;
  const douyin = getSourceProvider() === "douyin";
  let sessdata = "";
  let browserCookies = "";
  if (douyin) {
    if (window.confirm("是否允许本次刷新临时读取 Chrome 中的抖音登录状态？\n\n选择“取消”会先按公开访问刷新。")) browserCookies = "chrome";
  } else {
    sessdata = sessdataInput.value.trim() || window.prompt("粘贴 SESSDATA（只填 Cookie 的值，不要包含 SESSDATA=）", "")?.trim();
    if (!sessdata) {
      showToast("没有填写 SESSDATA，未开始刷新。", "error");
      return;
    }
  }

  state.subtitleRefreshing = true;
  refreshSubtitlesButton.disabled = true;
  refreshSubtitlesButton.textContent = "获取中…";
  try {
    const payload = await api(`/api/notes/${state.note.id}/subtitles`, {
      method: "POST",
      body: JSON.stringify({ sessdata, browserCookies })
    });
    state.note = payload.note;
    state.notes = state.notes.map((item) => item.id === state.note.id ? payload.note : item);
    renderNotes();
    renderNote();
    if (payload.note.processing?.subtitle === "ready" && !payload.preserved) {
      showToast(payload.message || "原始字幕已更新。", "success");
    } else {
      showToast(payload.message || "没有拿到可用字幕。", "error");
    }
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    state.subtitleRefreshing = false;
    sessdataInput.value = "";
    if (state.note) renderNoteHeader();
  }
}

async function uploadLocalMedia(file) {
  if (!state.note || !file) return;
  const allowed = /^(video\/(mp4|quicktime|webm)|audio\/(mpeg|mp4|x-m4a|wav|x-wav))$/i.test(file.type)
    || /\.(mp4|m4v|mov|webm|mp3|m4a|wav)$/i.test(file.name);
  if (!allowed) {
    showToast("请选择 MP4、MOV、WebM、MP3、M4A 或 WAV 文件。", "error");
    return;
  }
  if (file.size > 4 * 1024 * 1024 * 1024) {
    showToast("媒体文件超过 4GB，未开始上传。", "error");
    return;
  }
  if (!window.confirm(`将“${file.name}”保存到当前笔记的本地媒体缓存，供播放器、ASR 和说话人识别使用。确认继续吗？`)) return;
  showToast("正在写入本地媒体，请稍候…", "success");
  try {
    const response = await fetch(`/api/notes/${encodeURIComponent(state.note.id)}/media`, {
      method: "PUT",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-File-Name": encodeURIComponent(file.name)
      },
      body: file
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.message || `本地媒体写入失败（HTTP ${response.status}）`);
    state.note = payload.note;
    state.notes = state.notes.map((item) => item.id === state.note.id ? payload.note : item);
    renderNote();
    showToast("本地媒体已就绪；现在可以启动 ASR 或按时间戳播放。", "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    mediaUploadInput.value = "";
  }
}

function getPages() {
  return state.note?.transcript?.original?.pages || [];
}

function getSelectedPage() {
  const pages = getPages();
  return pages[state.pageIndex] || pages[0] || null;
}

function getSelectedTrack() {
  const page = getSelectedPage();
  if (!page) return null;
  return page.subtitles?.[state.trackIndex] || page.subtitles?.[0] || null;
}

function analysisTrackIdentity(track) {
  return [String(track?.language || track?.languageName || track?.label || track?.id || ""), track?.isAI ? "ai" : "public"].join("|");
}

function analysisSourceKey(page, track) {
  const trackKey = String(track?.id || track?.language || track?.languageName || "track").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `p${Number(page?.page || 1)}::${trackKey}`;
}

function getAnalysisSources() {
  const pages = getPages();
  const selectedPage = getSelectedPage();
  const selectedTrack = getSelectedTrack();
  if (!selectedPage || !selectedTrack) return [];
  const selectedIdentity = analysisTrackIdentity(selectedTrack);
  const targetPages = state.analysisPageScope === "all" ? pages : [selectedPage];
  const sources = [];

  targetPages.forEach((page) => {
    const pageTracks = page.subtitles || [];
    const targetTracks = state.analysisTrackScope === "all"
      ? pageTracks
      : page === selectedPage
        ? [selectedTrack]
        : pageTracks.filter((track) => analysisTrackIdentity(track) === selectedIdentity).slice(0, 1);
    targetTracks.forEach((track) => {
      const segments = flattenTrack(track);
      if (!segments.length) return;
      sources.push({
        sourceKey: analysisSourceKey(page, track),
        pageIndex: pages.indexOf(page),
        page: Number(page.page || 1),
        part: page.part || `P${page.page}`,
        trackId: String(track.id || ""),
        languageName: String(track.languageName || "未知语言"),
        label: String(track.label || "字幕"),
        segments
      });
    });
  });
  return sources;
}

function renderAnalysisScope() {
  if (!state.note) return;
  analysisPageScopeSelect.value = state.analysisPageScope;
  analysisTrackScopeSelect.value = state.analysisTrackScope;
  const sources = getAnalysisSources();
  const totalSegments = sources.reduce((sum, source) => sum + source.segments.length, 0);
  const pageLabel = state.analysisPageScope === "all" ? `全部 P（${new Set(sources.map((source) => source.page)).size} 个）` : `P${getSelectedPage()?.page || "-"}`;
  const trackLabel = state.analysisTrackScope === "all" ? `全部轨道（${sources.length} 条）` : (sources[0]?.languageName || "当前轨道");
  analysisScopeSummary.textContent = sources.length ? `${pageLabel} / ${trackLabel} / ${totalSegments} 段` : "当前范围无字幕";
  analysisScopeSummary.title = sources.length ? `本次 AI 将处理 ${sources.length} 条字幕轨道、${totalSegments} 个片段` : "当前选择范围没有可用字幕";
}

function providerChatModels(provider) {
  const models = provider?.chat_models || provider?.chatModels || [];
  return Array.isArray(models) ? models : [];
}

function providerSupportsChat(provider) {
  return providerChatModels(provider).length > 0 || ["runninghub", "volcengine", "apimart"].includes(provider?.protocol);
}

function providerListForEngine() {
  const providers = Array.isArray(state.aiEngines?.providers) ? state.aiEngines.providers : [];
  if (noteEngineSelect.value === "codex") {
    return providers.filter((provider) => provider.id === "codex" || provider.protocol === "codex");
  }
  return providers.filter((provider) => provider.enabled !== false
    && !["codex", "gemini-cli"].includes(provider.id)
    && !["codex", "gemini-cli"].includes(provider.protocol)
    && providerSupportsChat(provider));
}

function renderAiControls() {
  if (!state.note || !noteProviderSelect || !noteModelSelect) return;
  const engine = noteEngineSelect.value;
  const providers = providerListForEngine();
  const defaultProvider = engine === "codex" ? "codex" : state.aiEngines?.defaultProvider || "";
  const storedProvider = state.note.settings?.provider || "";
  const savedProvider = engine === "codex"
    ? "codex"
    : providers.some((provider) => provider.id === storedProvider)
      ? storedProvider
      : defaultProvider;
  const providerOptions = providers.map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name || provider.id)}</option>`).join("");
  noteProviderSelect.innerHTML = providerOptions || `<option value="">${state.aiEngines?.configured ? "暂无可用平台" : "先配置 AI 底座"}</option>`;
  noteProviderSelect.value = savedProvider;
  const provider = providers.find((item) => item.id === savedProvider);
  const models = providerChatModels(provider);
  const storedModel = state.note.settings?.model || "";
  const savedModel = models.length && !models.includes(storedModel) ? "" : storedModel;
  const engineDefaultModel = engine === "codex" ? models[0] : state.aiEngines?.defaultModel;
  const defaultModelLabel = engineDefaultModel ? `底座默认模型（${engineDefaultModel}）` : "底座默认模型";
  noteModelSelect.innerHTML = `<option value="">${escapeHtml(defaultModelLabel)}</option>${models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join("")}`;
  if (savedModel && !models.includes(savedModel)) {
    noteModelSelect.insertAdjacentHTML("afterbegin", `<option value="${escapeHtml(savedModel)}">已保存：${escapeHtml(savedModel)}</option>`);
  }
  noteModelSelect.value = savedModel;
  noteProviderSelect.disabled = engine !== "api" || !providers.length || Boolean(state.activeTaskId);
  noteModelSelect.disabled = !["api", "codex"].includes(engine) || Boolean(state.activeTaskId);
}

function getOriginalSegments() {
  const track = getSelectedTrack();
  return (track?.segments || track?.body || []).map((segment, index) => ({
    id: segment.id || `segment-${index}`,
    from: Number(segment.from || 0),
    to: Number(segment.to || 0),
    text: String(segment.text || segment.content || "")
  })).filter((segment) => segment.text.trim());
}

function polishedSentenceCount(text) {
  return (String(text || "").match(/[。！？!?]+/g) || []).length;
}

function mergeDisplayParagraphs(segments) {
  const output = [];
  for (const segment of segments || []) {
    if (!String(segment.text || "").trim()) continue;
    const previous = output[output.length - 1];
    const joined = previous ? `${previous.text} ${segment.text}`.replace(/\s+([，。！？、；：,.!?;:])/g, "$1").trim() : String(segment.text).trim();
    const canMerge = previous
      && Number(segment.from) - Number(previous.to) <= 4
      && Number(segment.to) - Number(previous.from) <= 45
      && joined.length <= 320
      && polishedSentenceCount(previous.text) < 4;
    if (canMerge) {
      previous.to = Number(segment.to);
      previous.text = joined;
      previous.sourceSegmentIds.push(segment.id || segment.segmentId);
    } else {
      output.push({
        ...segment,
        id: `paragraph-display-${segment.id || segment.segmentId || output.length + 1}`,
        text: String(segment.text).trim(),
        sourceSegmentIds: [segment.id || segment.segmentId].filter(Boolean)
      });
    }
  }
  return output;
}

function getDisplaySegments() {
  if (state.transcriptMode === "original") return getOriginalSegments();
  if (state.transcriptMode === "speaker") {
    const key = analysisSourceKey(getSelectedPage(), getSelectedTrack());
    return state.note.transcript?.speaker?.variants?.[key]?.segments || [];
  }
  const target = state.note.transcript?.polished;
  if (["ready", "partial"].includes(target?.status)) {
    const key = analysisSourceKey(getSelectedPage(), getSelectedTrack());
    const variant = target.variants ? target.variants[key] : target;
    const segments = variant?.segments || [];
    return variant?.paragraphs?.length ? variant.paragraphs : mergeDisplayParagraphs(segments);
  }
  return [];
}

function syncTranscriptTabs() {
  $$(".transcript-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.transcriptMode === state.transcriptMode);
  });
}

function setTranscriptMode(mode) {
  state.transcriptMode = ["polished", "speaker"].includes(mode) ? mode : "original";
  syncTranscriptTabs();
  renderTranscript();
}

function renderNoteHeader() {
  const note = state.note;
  const provider = getSourceProvider(note);
  const identifier = getSourceId(note);
  const platform = sourcePlatformLabel(note);
  noteTitle.value = note.title || note.source.title;
  fitNoteTitle();
  noteSourceMeta.textContent = `${note.source.author || (provider === "douyin" ? "未知作者" : "未知UP主")} · ${platform} ${identifier} · ${formatTime(note.source.duration)}`;
  noteOriginalLink.href = note.source.url;
  playerOpenLink.href = note.source.url;
  playerFallbackLink.href = note.source.url;
  noteProcessingStatus.textContent = isPendingNote(note) ? "等待音频转写" : note.processing?.ai === "ready" ? "AI 内容已生成" : "原文已保存";
  refreshSubtitlesButton.textContent = provider === "douyin"
    ? "刷新视频信息"
    : note.processing?.subtitle === "ready" ? "重新获取字幕" : "获取原始字幕";
  refreshSubtitlesButton.disabled = Boolean(state.subtitleRefreshing);
  renderAsrButton();
  noteEngineSelect.value = state.note.settings?.processingEngine || "api";
  renderTags();
}

function renderTags() {
  const tags = state.note?.tags || [];
  noteTags.innerHTML = `${tags.map((tag) => `<button class="note-tag editable-tag" data-remove-tag="${escapeHtml(tag)}" type="button" title="删除标签">${escapeHtml(tag)} ×</button>`).join("")}<button id="add-tag-button" class="add-tag-button" type="button">+ 标签</button>`;
}

function renderPageOptions() {
  const pages = getPages();
  state.pageIndex = Math.min(state.pageIndex, Math.max(0, pages.length - 1));
  pageSelect.innerHTML = pages.length
    ? pages.map((page, index) => getSourceProvider() === "douyin"
      ? `<option value="${index}">${escapeHtml(page.part || "抖音视频")}</option>`
      : `<option value="${index}">P${page.page} · ${escapeHtml(page.part || `P${page.page}`)}</option>`).join("")
    : `<option value="0">暂无分 P</option>`;
  pageSelect.value = String(state.pageIndex);
}

function renderTrackOptions() {
  const page = getSelectedPage();
  const tracks = page?.subtitles || [];
  state.trackIndex = Math.min(state.trackIndex, Math.max(0, tracks.length - 1));
  trackSelect.innerHTML = tracks.length
    ? tracks.map((track, index) => `<option value="${index}">${escapeHtml(track.label || "字幕")} · ${escapeHtml(track.languageName || "未知")} · ${(track.segments || track.body || []).length} 段</option>`).join("")
    : `<option value="0">暂无字幕轨道</option>`;
  trackSelect.value = String(state.trackIndex);
}

function renderTranscriptState() {
  const mode = state.transcriptMode;
  const target = mode === "polished"
    ? state.note.transcript?.polished
    : mode === "speaker" ? state.note.transcript?.speaker : null;
  const available = getDisplaySegments().length;
  const isPolished = mode === "polished";
  transcriptState.hidden = available > 0 && target?.status !== "partial";
  if (available > 0) {
    if (target?.status === "partial") {
      const taskId = getGenerationStatus("polish").taskId || "";
      transcriptState.innerHTML = `<div class="state-mark">!</div><strong>当前结果为部分完成</strong><p>${escapeHtml(target.partialMessage || "已保留成功分块，可只重试失败分块。")}</p>${taskId ? `<button class="structure-generate" data-retry-task="${escapeHtml(taskId)}" type="button">重试失败分块 ↗</button>` : ""}`;
    }
    return;
  }
  transcriptState.innerHTML = mode === "speaker"
    ? `<div class="state-mark">◉</div><strong>当前范围还没有说话人版</strong><p>只在你主动点击后运行 CAM++；会优先拼接当前范围的 AI 润色版，否则使用原文，不调用 LLM。</p><button class="structure-generate" data-start-diarization type="button">启动说话人识别 ↗</button>`
    : isPolished
    ? `<div class="state-mark">✦</div><strong>${target?.status === "ready" ? "当前范围还没有生成" : "AI润色版还没有生成"}</strong><p>点击上方按钮，使用当前选择的 AI 引擎处理原文。</p>`
    : `<div class="state-mark">!</div><strong>当前没有可用字幕</strong><p>${getSourceProvider() === "douyin" ? "抖音没有稳定的平台字幕入口；启动后会在本机获取媒体并使用 FunASR 生成时间轴。" : "可只下载音频，在本机使用 FunASR 生成带时间轴的原文；不会自动运行说话人识别。"}</p><button class="structure-generate" data-start-asr type="button">启动本地 ASR ↗</button>`;
}

function renderTranscript() {
  renderTranscriptState();
  const query = state.transcriptSearch.trim().toLowerCase();
  const allSegments = getDisplaySegments();
  const labels = state.note?.speaker?.labels || {};
  const speakerIds = [...new Set(allSegments.map((segment) => segment.speakerId).filter(Boolean))];
  if (state.transcriptMode !== "speaker" || !speakerIds.length) {
    state.speakerFilter = "all";
    speakerFilterControl.hidden = true;
    speakerFilter.innerHTML = '<option value="all">全部说话人</option>';
  } else {
    if (!speakerIds.includes(state.speakerFilter)) state.speakerFilter = "all";
    speakerFilterControl.hidden = false;
    speakerFilter.innerHTML = [
      `<option value="all">全部说话人（${allSegments.length}）</option>`,
      ...speakerIds.map((speakerId) => `<option value="${escapeHtml(speakerId)}">${escapeHtml(labels[speakerId] || speakerId)}（${allSegments.filter((segment) => segment.speakerId === speakerId).length}）</option>`)
    ].join("");
    speakerFilter.value = state.speakerFilter;
  }
  const activeSpeakerFilter = state.transcriptMode === "speaker" && state.speakerFilter !== "all" ? state.speakerFilter : "";
  const filteredBySpeaker = allSegments.filter((segment) => !activeSpeakerFilter || segment.speakerId === activeSpeakerFilter);
  const segments = filteredBySpeaker.filter((segment) => !query || segment.text.toLowerCase().includes(query));
  const page = getSelectedPage();
  const track = getSelectedTrack();
  const modeLabel = state.transcriptMode === "original" ? "原文" : state.transcriptMode === "speaker" ? "说话人版" : "AI润色版";
  syncTranscriptTabs();
  const speakerVariant = state.note?.transcript?.speaker?.variants?.[analysisSourceKey(getSelectedPage(), getSelectedTrack())];
  transcriptMeta.textContent = track
    ? state.transcriptMode === "speaker"
      ? `${modeLabel} · ${speakerVariant?.source === "polished" ? "使用 AI 润色文字" : "使用原文"} · 按说话人确定性拼接`
      : state.transcriptMode === "polished"
        ? `${modeLabel} · ${track.languageName || "未知语言"} · 段落式阅读 · 保留源字幕关系`
        : `${modeLabel} · ${track.languageName || "未知语言"} · 原始时间轴保留`
    : `${modeLabel} · 等待字幕`;
  speakerLabels.hidden = state.transcriptMode !== "speaker" || !speakerIds.length;
  speakerLabels.innerHTML = speakerIds.map((speakerId) => `<button class="speaker-label-button" data-speaker-label="${escapeHtml(speakerId)}" type="button" title="点击重命名">${escapeHtml(labels[speakerId] || speakerId)} ✎</button>`).join("");
  const hasTranscriptFilter = Boolean(query || activeSpeakerFilter);
  segmentCount.textContent = hasTranscriptFilter ? `${segments.length} / ${allSegments.length} 段` : `${allSegments.length} 段`;
  transcriptList.innerHTML = segments.length ? segments.map((segment, index) => `
    <article class="transcript-row ${state.transcriptMode === "polished" ? "is-paragraph" : ""} ${segment.id === state.activeSegmentId ? "is-active" : ""}" data-segment-id="${escapeHtml(segment.id)}" data-speaker="${escapeHtml(segment.speakerId || "")}" style="--row-delay:${Math.min(index * 16, 260)}ms">
      <button class="timestamp" data-seek="${Number(segment.from) || 0}" type="button">${formatTime(segment.from)}</button>
      <p class="segment-copy">${state.transcriptMode === "speaker" ? `<span class="speaker-name">${escapeHtml(labels[segment.speakerId] || segment.speakerId || "未确定")}</span>` : ""}${escapeHtml(segment.text)}</p>
    </article>`).join("")
    : allSegments.length && hasTranscriptFilter
      ? `<div class="transcript-empty-inline"><span>⌕</span><strong>没有匹配片段</strong><p>${activeSpeakerFilter ? `${escapeHtml(labels[activeSpeakerFilter] || activeSpeakerFilter)}没有匹配当前搜索条件。` : "没有找到匹配当前搜索条件的文字。"}</p></div>`
      : "";
  if (page && track && !allSegments.length && state.transcriptMode === "original") {
    transcriptList.innerHTML = `<div class="transcript-empty-inline"><span>—</span><strong>这条轨道没有可显示的文字。</strong><p>可以切换其他字幕轨道，或者稍后启动 ASR。</p></div>`;
  }
}

function buildPlayerSrc(seconds = 0, options = {}) {
  const source = state.note?.source;
  const page = getSelectedPage();
  if (getSourceProvider() === "douyin") {
    const videoId = String(source?.videoId || source?.sourceId || "");
    return /^\d+$/.test(videoId) ? `https://open.douyin.com/player/video?vid=${encodeURIComponent(videoId)}&autoplay=${options.autoplay ? "1" : "0"}` : "";
  }
  if (!source?.bvid) return "";
  const params = new URLSearchParams({
    bvid: source.bvid,
    p: String(page?.page || state.pageIndex + 1),
    danmaku: "0",
    autoplay: options.autoplay ? "1" : "0"
  });
  if (seconds > 0) params.set("t", String(Math.floor(seconds)));
  return `https://player.bilibili.com/player.html?${params.toString()}`;
}

function renderPlayer(seconds = 0, options = {}) {
  const source = state.note?.source;
  const provider = getSourceProvider();
  const hasLocalMedia = Boolean(state.note?.media?.status === "ready" && state.note?.media?.videoPath);
  playerFrame.hidden = true;
  localPlayer.hidden = true;
  playerFallback.hidden = true;
  if (provider === "douyin" && hasLocalMedia) {
    localPlayer.hidden = false;
    const mediaSrc = `/api/notes/${encodeURIComponent(state.note.id)}/media`;
    if (!localPlayer.getAttribute("src")?.includes(mediaSrc)) localPlayer.src = `${mediaSrc}?v=${encodeURIComponent(state.note.media.updatedAt || "1")}`;
    const applySeek = () => {
      if (Number.isFinite(localPlayer.duration)) localPlayer.currentTime = Math.min(Math.max(0, Number(seconds) || 0), localPlayer.duration || Number(seconds) || 0);
      if (options.autoplay) localPlayer.play().catch(() => {});
    };
    if (localPlayer.readyState >= 1) applySeek();
    else localPlayer.addEventListener("loadedmetadata", applySeek, { once: true });
  } else {
    const nextSrc = buildPlayerSrc(seconds, options);
    if (!nextSrc) {
      playerFallback.hidden = false;
      playerFallbackCopy.textContent = provider === "douyin"
        ? "当前分享链接无法嵌入；可以打开原视频，或选择本地媒体继续识别。"
        : "可以打开原视频继续观看。";
    } else {
      playerFrame.hidden = false;
      if (options.force || playerFrame.getAttribute("src") !== nextSrc) playerFrame.src = nextSrc;
    }
  }
  if (!source?.url) {
    playerFrame.hidden = true;
    localPlayer.hidden = true;
    playerFallback.hidden = false;
    return;
  }
  const external = provider === "bilibili"
    ? `${source.url}?p=${encodeURIComponent(getSelectedPage()?.page || state.pageIndex + 1)}&t=${Math.floor(seconds || 0)}`
    : source.url;
  playerOpenLink.href = external;
  playerFallbackLink.href = external;
  playerTitle.textContent = `${provider === "douyin" ? "抖音" : "B站"} · ${source.title || "视频"}${provider === "douyin" && hasLocalMedia ? " · 本地精确跳秒" : ""}`;
  playerTime.textContent = formatTime(seconds);
}

function scrollActiveTranscriptRow() {
  if (!state.activeSegmentId) return;
  const row = Array.from(transcriptList.querySelectorAll("[data-segment-id]")).find((item) => item.dataset.segmentId === state.activeSegmentId);
  row?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function sendPlayerSeek(seconds) {
  if (getSourceProvider() !== "bilibili") return;
  try {
    playerFrame.contentWindow?.postMessage({ command: "seek", time: seconds }, "*");
  } catch {
    // The iframe is cross-origin; the external B站 link remains available as a fallback.
  }
}

function seekTo(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  state.pendingSeekSeconds = value;
  playerTime.textContent = formatTime(value);
  if (getSourceProvider() === "douyin" && state.note?.media?.status !== "ready") {
    showToast("抖音在线预览不能可靠跳秒；请先运行本地 ASR 或选择本地媒体。", "error");
  } else {
    renderPlayer(value, { force: true, autoplay: true });
    sendPlayerSeek(value);
  }
  scrollActiveTranscriptRow();
}

function findSegmentById(segmentId) {
  const pages = getPages();
  for (const [pageIndex, page] of pages.entries()) {
    for (const [trackIndex, track] of (page.subtitles || []).entries()) {
      const segment = flattenTrack(track).find((item) => item.id === segmentId);
      if (segment) return { segment, page, pageIndex, trackIndex };
    }
  }
  return null;
}

function flattenTrack(track) {
  return (track?.segments || track?.body || []).map((segment, index) => ({
    id: segment.id || `segment-${index}`,
    from: Number(segment.from || 0),
    to: Number(segment.to || 0),
    text: String(segment.text || segment.content || "")
  }));
}

function renderTreeNode(node, labelKey = "label", depth = 0) {
  if (!node) return "";
  const label = node[labelKey] || node.title || "未命名节点";
  const segmentIds = Array.isArray(node.segmentIds) ? node.segmentIds : [];
  const children = Array.isArray(node.children) ? node.children : [];
  return `<li class="tree-node" style="--tree-depth:${depth}"><button data-structure-segments="${escapeHtml(JSON.stringify(segmentIds))}" type="button"><span class="tree-dot"></span>${escapeHtml(label)}</button>${children.length ? `<ul>${children.map((child) => renderTreeNode(child, labelKey, depth + 1)).join("")}</ul>` : ""}</li>`;
}

function renderOutlineNode(node, depth = 0) {
  if (!node || typeof node !== "object") return "";
  const title = String(node.title || node.label || "未命名节点");
  const summary = String(node.summary || "");
  const keyPoints = Array.isArray(node.keyPoints)
    ? node.keyPoints.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 4)
    : [];
  const segmentIds = Array.isArray(node.segmentIds) ? node.segmentIds : [];
  const children = Array.isArray(node.children) ? node.children : [];
  const references = escapeHtml(JSON.stringify(segmentIds));
  const pointMarkup = keyPoints.length
    ? '<ul class="outline-node-points">' + keyPoints.map((point) => '<li>' + escapeHtml(point) + '</li>').join("") + "</ul>"
    : "";
  const childMarkup = children.length
    ? '<ul class="outline-children">' + children.map((child) => renderOutlineNode(child, depth + 1)).join("") + "</ul>"
    : "";
  return '<li class="outline-node" style="--outline-depth:' + depth + '">'
    + '<button class="outline-node-title" data-structure-segments="' + references + '" type="button">'
    + '<span class="outline-node-marker"></span><span>' + escapeHtml(title) + "</span>"
    + (segmentIds.length ? '<small>引用 ' + segmentIds.length + " 段</small>" : "")
    + "</button>"
    + (summary ? '<p class="outline-node-summary">' + escapeHtml(summary) + "</p>" : "")
    + pointMarkup
    + childMarkup
    + "</li>";
}

function escapeSvg(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function mindmapTextLines(value, maxChars = 21, maxLines = 3) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const chars = Array.from(text);
  const lines = [];
  for (let index = 0; index < chars.length && lines.length < maxLines; index += maxChars) {
    lines.push(chars.slice(index, index + maxChars).join(""));
  }
  if (chars.length > maxChars * maxLines && lines.length) {
    lines[lines.length - 1] = lines[lines.length - 1].slice(0, Math.max(1, maxChars - 1)) + "…";
  }
  return lines;
}

function buildMindmapSvg(tree) {
  const root = tree && typeof tree === "object" ? tree : {};
  const nodeWidth = 238;
  const horizontalGap = 82;
  const verticalGap = 18;
  const padding = 30;
  const palettes = [
    { fill: "#25261c", stroke: "#e8ff73", text: "#f2eee5", muted: "#c8c2b5", edge: "#e8ff73" },
    { fill: "#2b211e", stroke: "#ff765f", text: "#f2eee5", muted: "#d0b8b0", edge: "#ff765f" },
    { fill: "#211e2d", stroke: "#ad91ff", text: "#f2eee5", muted: "#c9bfdf", edge: "#ad91ff" },
    { fill: "#1d2927", stroke: "#72d8bf", text: "#f2eee5", muted: "#b9d8cf", edge: "#72d8bf" }
  ];

  function makeNode(node, depth, isRoot = false) {
    const source = node && typeof node === "object" ? node : {};
    const label = String(source.label || source.title || (isRoot ? state.note?.title : "未命名节点"));
    const relation = String(source.relation || "");
    const summary = String(source.summary || "");
    const detail = relation && summary ? "关系：" + relation + " · " + summary : (relation ? "关系：" + relation : summary);
    const keywords = Array.isArray(source.keywords)
      ? source.keywords.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 5)
      : [];
    const labelLines = mindmapTextLines(label, isRoot ? 23 : 19, 2);
    const detailLines = mindmapTextLines(detail, 29, isRoot ? 3 : 2);
    const keywordLine = keywords.length ? "关键词：" + keywords.join(" · ") : "";
    const height = Math.max(
      isRoot ? 100 : 82,
      28 + labelLines.length * 21 + (detailLines.length ? 8 + detailLines.length * 16 : 0) + (keywordLine ? 22 : 0)
    );
    const children = Array.isArray(source.children)
      ? source.children.map((child) => makeNode(child, depth + 1, false))
      : [];
    return {
      source,
      depth,
      isRoot,
      label,
      labelLines,
      detailLines,
      keywordLine,
      height,
      children,
      subtreeHeight: height,
      x: 0,
      y: 0
    };
  }

  function measure(record) {
    if (!record.children.length) {
      record.subtreeHeight = record.height;
      return record.subtreeHeight;
    }
    const childrenHeight = record.children.reduce(
      (total, child, index) => total + measure(child) + (index ? verticalGap : 0),
      0
    );
    record.subtreeHeight = Math.max(record.height, childrenHeight);
    return record.subtreeHeight;
  }

  const rootRecord = makeNode(root, 0, true);
  measure(rootRecord);
  const records = [];
  const edges = [];

  function place(record, top) {
    record.x = padding + record.depth * (nodeWidth + horizontalGap);
    record.y = top + (record.subtreeHeight - record.height) / 2;
    records.push(record);
    let childTop = top;
    record.children.forEach((child) => {
      edges.push({ parent: record, child });
      place(child, childTop);
      childTop += child.subtreeHeight + verticalGap;
    });
  }

  place(rootRecord, padding);
  const maxDepth = records.reduce((max, record) => Math.max(max, record.depth), 0);
  const width = padding * 2 + (maxDepth + 1) * nodeWidth + maxDepth * horizontalGap;
  const height = Math.max(360, rootRecord.subtreeHeight + padding * 2);

  function textMarkup(lines, x, y, fontSize, fill, weight, lineHeight) {
    if (!lines.length) return "";
    return '<text x="' + x + '" y="' + y + '" fill="' + fill + '" font-size="' + fontSize
      + '" font-weight="' + weight + '" font-family="PingFang SC, Hiragino Sans GB, sans-serif">'
      + lines.map((line, index) => '<tspan x="' + x + '" dy="' + (index ? lineHeight : 0) + '">' + escapeSvg(line) + "</tspan>").join("")
      + "</text>";
  }

  const edgeMarkup = edges.map(({ parent, child }) => {
    const startX = parent.x + nodeWidth;
    const startY = parent.y + parent.height / 2;
    const endX = child.x;
    const endY = child.y + child.height / 2;
    const curve = Math.max(34, (endX - startX) * 0.52);
    const palette = palettes[child.depth % palettes.length];
    return '<path d="M ' + startX + " " + startY + " C " + (startX + curve) + " " + startY + ", "
      + (endX - curve) + " " + endY + ", " + endX + " " + endY
      + '" fill="none" stroke="' + palette.edge + '" stroke-opacity="0.62" stroke-width="2.2"/>';
  }).join("");

  const nodeMarkup = records.map((record) => {
    const palette = palettes[record.depth % palettes.length];
    const x = record.x;
    const y = record.y;
    let cursorY = y + 25;
    const labelMarkup = textMarkup(record.labelLines, x + 16, cursorY, record.isRoot ? 17 : 14, palette.text, "600", 21);
    cursorY += record.labelLines.length * 21;
    const detailMarkup = record.detailLines.length
      ? textMarkup(record.detailLines, x + 16, cursorY + 10, 11, palette.muted, "400", 16)
      : "";
    cursorY += record.detailLines.length ? 20 + record.detailLines.length * 16 : 0;
    const keywordMarkup = record.keywordLine
      ? textMarkup([record.keywordLine], x + 16, cursorY + 5, 9, palette.stroke, "500", 13)
      : "";
    const referenceCount = Array.isArray(record.source.segmentIds) ? record.source.segmentIds.length : 0;
    const referenceMarkup = referenceCount
      ? '<g><rect x="' + (x + nodeWidth - 59) + '" y="' + (y + 11) + '" width="45" height="18" rx="9" fill="' + palette.stroke + '" fill-opacity="0.14" stroke="' + palette.stroke + '" stroke-opacity="0.5"/>'
        + '<text x="' + (x + nodeWidth - 36.5) + '" y="' + (y + 23.5) + '" text-anchor="middle" fill="' + palette.stroke + '" font-size="9" font-family="monospace">引用 ' + referenceCount + "</text></g>"
      : "";
    return '<g class="mindmap-node" data-depth="' + record.depth + '">'
      + '<rect x="' + x + '" y="' + y + '" width="' + nodeWidth + '" height="' + record.height + '" rx="12" fill="' + palette.fill + '" stroke="' + palette.stroke + '" stroke-opacity="' + (record.isRoot ? "0.95" : "0.62") + '" stroke-width="' + (record.isRoot ? "2.4" : "1.5") + '"/>'
      + '<rect x="' + x + '" y="' + y + '" width="5" height="' + record.height + '" rx="3" fill="' + palette.stroke + '" fill-opacity="0.9"/>'
      + labelMarkup + detailMarkup + keywordMarkup + referenceMarkup
      + "</g>";
  }).join("");

  const svg = '<svg class="mindmap-svg" xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height
    + '" viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="思维导图">'
    + '<rect width="100%" height="100%" fill="#191815" fill-opacity="0.92"/>'
    + '<g>' + edgeMarkup + nodeMarkup + "</g></svg>";
  return { svg, width, height };
}

function mindmapSurfaceMarkup(tree, inDialog = false) {
  const layout = buildMindmapSvg(tree);
  const fullscreenButton = inDialog ? "" : '<button data-mindmap-action="fullscreen" type="button" title="全屏查看">全屏</button>';
  return '<div class="mindmap-surface" data-mindmap-surface data-mindmap-zoom="1" data-mindmap-width="' + layout.width + '" data-mindmap-height="' + layout.height + '">'
    + '<div class="mindmap-toolbar"><span><b>概念关系视图</b><small>按概念、因果和方法组织</small></span><div class="mindmap-toolbar-actions">'
    + '<button data-mindmap-action="zoom-out" type="button" title="缩小">−</button>'
    + '<button data-mindmap-action="fit" type="button" title="适应窗口">适应</button>'
    + '<button data-mindmap-action="zoom-in" type="button" title="放大">＋</button>'
    + fullscreenButton
    + '<button data-mindmap-action="export-svg" type="button" title="导出 SVG">SVG</button>'
    + '<button data-mindmap-action="export-png" type="button" title="导出 PNG">PNG</button>'
    + "</div></div>"
    + '<div class="mindmap-viewport"><div class="mindmap-svg-wrap" data-mindmap-svg-wrap>' + layout.svg + "</div></div>"
    + '<div class="mindmap-caption">思维导图用于直观看结构；文字大纲节点可点击跳回对应字幕。</div>'
    + "</div>";
}

function applyMindmapZoom(surface, zoom) {
  if (!surface) return;
  const value = Math.min(2.4, Math.max(0.45, Number(zoom) || 1));
  const wrap = surface.querySelector("[data-mindmap-svg-wrap]");
  if (!wrap) return;
  const svg = surface.querySelector(".mindmap-svg");
  const rawWidth = Number(svg?.getAttribute("width")) || Number(surface.dataset.mindmapWidth) || 1;
  const rawHeight = Number(svg?.getAttribute("height")) || Number(surface.dataset.mindmapHeight) || 1;
  wrap.style.transformOrigin = "top left";
  wrap.style.transform = "scale(" + value + ")";
  wrap.style.width = `${Math.max(rawWidth * value, 1)}px`;
  wrap.style.height = `${Math.max(rawHeight * value, 1)}px`;
  surface.dataset.mindmapZoom = String(value);
}

function fitMindmap(surface) {
  if (!surface) return;
  const viewport = surface.querySelector(".mindmap-viewport");
  const svg = surface.querySelector(".mindmap-svg");
  if (!viewport || !svg) return applyMindmapZoom(surface, 1);
  const rawWidth = Number(svg.getAttribute("width")) || 1;
  const rawHeight = Number(svg.getAttribute("height")) || 1;
  const availableWidth = Math.max(1, viewport.clientWidth - 26);
  const availableHeight = Math.max(1, viewport.clientHeight - 26);
  const value = Math.min(1, availableWidth / rawWidth, availableHeight / rawHeight);
  applyMindmapZoom(surface, Math.max(0.45, value));
}

function bindMindmapSurface(surface) {
  if (!surface || surface.dataset.mindmapBound === "true") return;
  const viewport = surface.querySelector(".mindmap-viewport");
  if (!viewport) return;
  surface.dataset.mindmapBound = "true";
  let panState = null;

  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    panState = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop
    };
    viewport.setPointerCapture?.(event.pointerId);
    viewport.classList.add("is-panning");
    event.preventDefault();
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!panState || panState.pointerId !== event.pointerId) return;
    viewport.scrollLeft = panState.scrollLeft - (event.clientX - panState.x);
    viewport.scrollTop = panState.scrollTop - (event.clientY - panState.y);
  });
  const endPan = (event) => {
    if (!panState || panState.pointerId !== event.pointerId) return;
    viewport.releasePointerCapture?.(event.pointerId);
    panState = null;
    viewport.classList.remove("is-panning");
  };
  viewport.addEventListener("pointerup", endPan);
  viewport.addEventListener("pointercancel", endPan);
  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    const current = Number(surface.dataset.mindmapZoom || 1);
    const direction = event.deltaY < 0 ? 1 : -1;
    const next = Math.min(2.4, Math.max(0.45, current + direction * 0.12));
    if (next === current) return;
    const rect = viewport.getBoundingClientRect();
    const focusX = event.clientX - rect.left + viewport.scrollLeft;
    const focusY = event.clientY - rect.top + viewport.scrollTop;
    applyMindmapZoom(surface, next);
    viewport.scrollLeft = focusX * (next / current) - (event.clientX - rect.left);
    viewport.scrollTop = focusY * (next / current) - (event.clientY - rect.top);
  }, { passive: false });
}

function safeDownloadName(value) {
  return String(value || "思维导图")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "思维导图";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportMindmap(surface, format) {
  const svg = surface?.querySelector(".mindmap-svg");
  if (!svg) return;
  const clone = svg.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const source = new XMLSerializer().serializeToString(clone);
  const baseName = safeDownloadName((state.note?.title || "视频笔记") + "-" + (state.note?.source?.bvid || "") + "-思维导图");
  if (format === "svg") {
    downloadBlob(new Blob(["<?xml version=\"1.0\" encoding=\"UTF-8\"?>\\n", source], { type: "image/svg+xml;charset=utf-8" }), baseName + ".svg");
    showToast("思维导图 SVG 已导出", "success");
    return;
  }
  const imageUrl = URL.createObjectURL(new Blob([source], { type: "image/svg+xml;charset=utf-8" }));
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = Number(svg.getAttribute("width")) || 1200;
    canvas.height = Number(svg.getAttribute("height")) || 800;
    const context = canvas.getContext("2d");
    context.fillStyle = "#191815";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) {
        downloadBlob(blob, baseName + ".png");
        showToast("思维导图 PNG 已导出", "success");
      }
      URL.revokeObjectURL(imageUrl);
    }, "image/png");
  };
  image.onerror = () => {
    URL.revokeObjectURL(imageUrl);
    showToast("思维导图 PNG 导出失败，可改用 SVG。", "error");
  };
  image.src = imageUrl;
}

function openMindmapDialog() {
  const tree = state.note?.mindmap?.tree;
  if (!tree || !mindmapDialog || !mindmapDialogContent) return;
  mindmapDialogContent.innerHTML = mindmapSurfaceMarkup(tree, true);
  if (!mindmapDialog.open) mindmapDialog.showModal();
  window.setTimeout(() => {
    const surface = mindmapDialogContent.querySelector("[data-mindmap-surface]");
    bindMindmapSurface(surface);
    fitMindmap(surface);
  }, 0);
}

function handleMindmapAction(action, surface) {
  if (!surface) return;
  const current = Number(surface.dataset.mindmapZoom || 1);
  if (action === "zoom-in") applyMindmapZoom(surface, current + 0.15);
  if (action === "zoom-out") applyMindmapZoom(surface, current - 0.15);
  if (action === "fit") fitMindmap(surface);
  if (action === "fullscreen") openMindmapDialog();
  if (action === "export-svg") exportMindmap(surface, "svg");
  if (action === "export-png") exportMindmap(surface, "png");
}

function renderLeftPanel() {
  if (!state.note) return;
  const target = state.leftTab === "outline" ? state.note.outline : state.note.mindmap;
  if (!target || target.status !== "ready" || !target.tree) {
    const isOutline = state.leftTab === "outline";
    leftContent.innerHTML = '<div class="structure-empty"><div class="structure-empty-mark">' + (isOutline ? "≡" : "✦") + '</div><strong>' + (isOutline ? "文字大纲还没有生成" : "思维导图还没有生成") + '</strong><p>' + (isOutline ? "点击文字稿上方“生成大纲”，或使用“同时生成”。" : "请先生成 AI 润色版，再点击“同时生成”查看可视化导图。") + '</p><button class="structure-generate" data-structure-action="' + state.leftTab + '" type="button">' + (isOutline ? "生成大纲" : "生成导图") + ' ↗</button></div>';
    return;
  }
  if (state.leftTab === "outline") {
    const tree = target.tree;
    const items = tree.items || tree.children || [];
    leftContent.innerHTML = '<div class="structure-title">' + escapeHtml(tree.title || state.note.title) + '</div>' + (tree.summary ? '<p class="structure-summary">' + escapeHtml(tree.summary) + '</p>' : '') + '<ul class="structure-tree outline-tree">' + items.map((item) => renderOutlineNode(item)).join("") + '</ul>';
  } else {
    leftContent.innerHTML = mindmapSurfaceMarkup(target.tree);
    window.setTimeout(() => {
      const surface = leftContent.querySelector("[data-mindmap-surface]");
      bindMindmapSurface(surface);
      fitMindmap(surface);
    }, 0);
  }
}

function renderRecord() {
  recordEditor.innerHTML = state.note?.record?.html || "";
  recordStatus.textContent = state.note?.record?.updatedAt ? `已保存 ${formatDate(state.note.record.updatedAt)}` : "未编辑";
}

function compactKnowledgeIds(values, limit = 12) {
  const ids = [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (!ids.length) return "";
  const visible = ids.slice(0, limit).map((value) => `<code>${escapeHtml(value)}</code>`).join(" ");
  return `${visible}${ids.length > limit ? `<span class="knowledge-more-count">另外 ${ids.length - limit} 项</span>` : ""}`;
}

function buildKnowledgeIntegrityView(knowledge, material, canCodex) {
  const completeness = material?.completeness || {};
  const chunks = Array.isArray(material?.chunks) ? material.chunks : [];
  const completedChunks = chunks.filter((chunk) => chunk.status === "completed");
  const failedChunks = chunks.filter((chunk) => chunk.status === "failed");
  const pendingChunks = chunks.filter((chunk) => ["queued", "running"].includes(chunk.status));
  const expectedSegments = Number(completeness.expectedSegmentCount || material?.snapshot?.segments?.length || 0);
  const processedSegments = completedChunks.reduce((sum, chunk) => sum + Number(chunk.segmentCount || chunk.segmentIds?.length || 0), 0);
  const expectedSourceSegments = Number(completeness.expectedSourceSegmentCount || material?.snapshot?.sourceSegmentCount || 0);
  const processedSourceSegments = Number(completeness.processedSourceSegmentCount || 0);
  const chunkCount = Number(completeness.chunkCount || chunks.length || 0);
  const completedCount = Number(completeness.completedChunkCount || completedChunks.length || 0);
  const percent = canCodex ? 100 : chunkCount ? Math.min(99, Math.round((completedCount / chunkCount) * 100)) : 0;
  const gaps = [];
  const addGap = (type, title, detail, ids = "") => gaps.push({ type, title, detail, ids });

  if (!material) {
    addGap("missing", "API 资料包尚未生成", "请先点击“1. API 整理资料”，系统才能建立分块清单并检查具体缺口。");
    if (knowledgeTranscriptMode?.value === "polished" && state.note.transcript?.polished?.status !== "ready") {
      addGap("missing", "AI 润色版未完整", "当前选择了 AI 润色版，但润色结果还没有达到 ready。");
    }
    if (knowledgeTranscriptMode?.value === "speaker" && state.note.transcript?.speaker?.status !== "ready") {
      addGap("missing", "说话人版尚未生成", "当前选择了说话人版；请先生成对应 P 和字幕轨道的说话人版，或改选 AI 润色版。");
    }
  }
  if (state.knowledgePreflightError) {
    const error = state.knowledgePreflightError;
    addGap("missing", error.message || "启动前检查未通过", `错误编号：${error.code || "KNOWLEDGE_PREFLIGHT_FAILED"}`, compactKnowledgeIds(error.details?.missingSegmentIds || error.details?.missingSources));
  }
  if (knowledge.status === "stale") addGap("missing", "锁定快照已失效", knowledge.staleReason || "字幕、润色版或说话人信息在资料整理后发生了变化。");
  failedChunks.forEach((chunk) => addGap(
    "failed",
    `第 ${Number(chunk.index || 0) + 1} 个 API 分块失败`,
    `${chunk.firstSegmentId || chunk.segmentIds?.[0] || "未知起点"} → ${chunk.lastSegmentId || chunk.segmentIds?.at?.(-1) || "未知终点"}。${chunk.error?.message || "请只重试该失败块。"}`,
    compactKnowledgeIds([chunk.id])
  ));
  if (pendingChunks.length) {
    addGap("pending", `${pendingChunks.length} 个分块尚未完成`, "排队中或处理中的分块仍然算作缺失，完成前 Codex 不会解锁。", compactKnowledgeIds(pendingChunks.map((chunk) => chunk.id), 8));
  }
  if (completeness.missingSegmentIds?.length) addGap("missing", `缺少 ${completeness.missingSegmentIds.length} 段字幕`, "这些字幕 ID 没有被任何资料分块覆盖。", compactKnowledgeIds(completeness.missingSegmentIds));
  if (completeness.missingSourceSegmentIds?.length) addGap("missing", `还有 ${completeness.missingSourceSegmentIds.length} 条源字幕未覆盖`, "知识段落可以合并，但任何一条源字幕都不能漏。请完成或重试对应 API 分块。", compactKnowledgeIds(completeness.missingSourceSegmentIds));
  if (completeness.duplicateSegmentIds?.length) addGap("failed", `${completeness.duplicateSegmentIds.length} 段字幕被重复覆盖`, "重复覆盖可能造成观点重复计算，必须重新整理。", compactKnowledgeIds(completeness.duplicateSegmentIds));
  if (completeness.invalidChunkIds?.length) addGap("failed", `${completeness.invalidChunkIds.length} 个分块未确认“无遗漏”`, "API 返回不符合资料契约，已拒绝当作完整资料。", compactKnowledgeIds(completeness.invalidChunkIds));
  if (knowledge.audit?.status === "BLOCKED") {
    (knowledge.audit.issues || []).forEach((issue) => addGap("failed", issue.message || issue.code || "Codex 审计未通过", `问题编号：${issue.code || "AUDIT_ISSUE"}`, compactKnowledgeIds([...(issue.chunkIds || []), ...(issue.segmentIds || [])])));
  }

  const checks = Array.isArray(completeness.checks) ? completeness.checks : [];
  const summary = [
    { label: "API 分块", value: chunkCount ? `${completedCount}/${chunkCount}` : "尚未建立", tone: completedCount === chunkCount && chunkCount ? "passed" : "neutral" },
    { label: "知识段落", value: expectedSegments ? `${processedSegments}/${expectedSegments}` : "待检查", tone: processedSegments === expectedSegments && expectedSegments ? "passed" : "neutral" },
    { label: "源字幕覆盖", value: expectedSourceSegments ? `${processedSourceSegments}/${expectedSourceSegments}` : "待检查", tone: processedSourceSegments === expectedSourceSegments && expectedSourceSegments ? "passed" : "neutral" },
    { label: "失败分块", value: String(failedChunks.length), tone: failedChunks.length ? "failed" : "passed" },
    { label: "快照版本", value: material?.snapshot?.transcriptMode === "polished" ? "AI 润色版" : material?.snapshot?.transcriptMode === "speaker" ? "说话人版" : material ? "原文" : "待锁定", tone: material ? "passed" : "neutral" }
  ];
  return { percent, gaps, checks, summary };
}

function renderKnowledgeTaskState() {
  const runtime = state.knowledgeTask;
  const material = state.note?.knowledge?.material;
  const isRunning = ["submitting", "queued", "running"].includes(runtime?.status);
  const isExtracting = runtime?.operation === "knowledge_extract";
  const materialReady = Boolean(material?.completeness?.ready);
  const materialPartial = Boolean(material && !materialReady);
  const elapsed = runtime ? formatElapsed(Date.now() - Number(runtime.startedAt || Date.now())) : "00:00";

  knowledgeApiLabel.textContent = material ? "1. 重新整理 API 资料" : "1. API 整理资料";
  let buttonTone = materialReady ? "completed" : materialPartial ? "partial" : "not_generated";
  let buttonStatus = materialReady ? "已完成" : materialPartial ? "部分完成" : "未开始";
  if (isExtracting && isRunning) {
    buttonTone = "running";
    buttonStatus = runtime.status === "submitting" ? "提交中" : `整理中 ${elapsed}`;
  } else if (isExtracting && runtime?.status === "failed") {
    buttonTone = materialPartial ? "partial" : "failed";
    buttonStatus = materialPartial ? "部分完成" : "失败";
  }
  knowledgeApiButton.dataset.generationStatus = buttonTone;
  knowledgeApiButtonStatus.textContent = buttonStatus;

  if (!runtime || !["knowledge_extract", "knowledge_synthesize"].includes(runtime.operation)) {
    knowledgeTaskProgress.hidden = true;
  } else {
    const metrics = runtime.metrics || {};
    const progress = runtime.status === "completed" ? 100 : runtime.progress;
    const completed = Number(metrics.completedChunkCount || 0);
    const chunks = Number(metrics.chunkCount || 0);
    const failed = Number(metrics.failedChunkCount || 0);
    const operationName = runtime.operation === "knowledge_extract" ? "API 资料整理" : "Codex 核查合成";
    const stateName = runtime.status === "submitting" ? "正在提交"
      : runtime.status === "queued" ? "已提交，等待开始"
        : runtime.status === "running" ? "正在执行"
          : runtime.status === "completed" ? "已经完成" : "执行失败";
    knowledgeTaskProgress.hidden = false;
    knowledgeTaskProgress.dataset.status = runtime.status;
    knowledgeTaskProgressMark.textContent = isRunning ? "◌" : runtime.status === "completed" ? "✓" : "!";
    knowledgeTaskProgressTitle.textContent = `${operationName} · ${stateName}`;
    knowledgeTaskProgressMessage.textContent = runtime.message || (isRunning ? "任务正在执行" : stateName);
    knowledgeTaskProgressPercent.textContent = `${progress}%`;
    knowledgeTaskProgressBar.style.width = `${progress}%`;
    knowledgeTaskProgressMeta.textContent = `${chunks ? `分块 ${completed}/${chunks}` : "正在建立分块"}${failed ? ` · 失败 ${failed} 块` : ""} · 已用时 ${elapsed}${runtime.taskId ? ` · ${runtime.taskId}` : ""}`;
  }

  if (isRunning && !state.knowledgeTimer) {
    state.knowledgeTimer = window.setInterval(renderKnowledgeWorkflow, 1000);
  } else if (!isRunning && state.knowledgeTimer) {
    window.clearInterval(state.knowledgeTimer);
    state.knowledgeTimer = null;
  }
  return { runtime, isRunning, isExtracting };
}

function renderKnowledgeWorkflow() {
  if (!knowledgeStatusBadge || !state.note) return;
  const knowledge = state.note.knowledge || {};
  const material = knowledge.material;
  const completeness = material?.completeness;
  const statuses = {
    not_started: ["尚未开始", "idle"], extracting: ["API 整理中", "running"], materials_partial: ["资料不完整", "blocked"],
    materials_ready: ["资料 100% · Codex 已解锁", "ready"], reviewing: ["Codex 核查中", "running"],
    blocked: ["Codex 已阻止合成", "blocked"], ready: ["总输出已就绪", "ready"], stale: ["源资料已变更", "blocked"]
  };
  const runtimeState = renderKnowledgeTaskState();
  const runtimeOperationLabel = runtimeState.runtime?.operation === "knowledge_extract" ? "API 整理中" : "Codex 核查中";
  const runtimeProgress = Number(runtimeState.runtime?.progress || 0);
  const [label, tone] = runtimeState.isRunning
    ? [`${runtimeOperationLabel} · ${runtimeProgress}%`, "running"]
    : statuses[knowledge.status] || statuses.not_started;
  knowledgeStatusBadge.textContent = label;
  knowledgeStatusBadge.dataset.tone = tone;
  knowledgeTranscriptMode.value = state.knowledgeTranscriptMode;
  const busy = Boolean(state.activeTaskId) || runtimeState.isRunning || ["extracting", "reviewing"].includes(knowledge.status);
  const canCodex = Boolean(completeness?.ready && material?.status === "ready" && !["stale", "extracting", "blocked"].includes(knowledge.status));
  knowledgeApiButton.disabled = busy;
  knowledgeCodexButton.disabled = busy || !canCodex;
  knowledgeTranscriptMode.disabled = busy;
  knowledgeCodexButton.textContent = knowledge.status === "ready" ? "2. 重新核查并合成" : "2. Codex 核查并合成";
  const integrity = buildKnowledgeIntegrityView(knowledge, material, canCodex);
  knowledgeReadinessLabel.textContent = canCodex ? "可合成" : "资料不完整";
  knowledgeReadinessButton.dataset.tone = canCodex ? "ready" : "blocked";
  knowledgeReadinessButton.setAttribute("aria-expanded", String(state.knowledgeDetailsOpen));
  knowledgeIntegrityPanel.hidden = !state.knowledgeDetailsOpen;
  knowledgeIntegrityPercent.textContent = `${integrity.percent}%`;
  knowledgeIntegrityPercent.dataset.tone = canCodex ? "ready" : "blocked";
  knowledgeIntegrityTitle.textContent = canCodex ? "资料完整，可交给 Codex" : `资料完整度检查${integrity.gaps.length ? ` · ${integrity.gaps.length} 类缺口` : ""}`;
  knowledgeIntegritySummary.innerHTML = integrity.summary.map((item) => `<div class="knowledge-integrity-stat ${item.tone}"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></div>`).join("");
  const checksMarkup = integrity.checks.length
    ? `<div class="knowledge-check-section"><h4>完整性检查</h4><ul>${integrity.checks.map((check) => `<li class="${check.passed ? "passed" : "failed"}"><span>${check.passed ? "✓" : "×"}</span><div><strong>${escapeHtml(check.label)}</strong></div></li>`).join("")}</ul></div>`
    : "";
  const gapsMarkup = integrity.gaps.length
    ? `<div class="knowledge-gap-section"><h4>缺失与阻断位置</h4><div class="knowledge-gap-list">${integrity.gaps.map((gap) => `<article class="knowledge-gap-item ${gap.type}"><span class="knowledge-gap-mark">${gap.type === "pending" ? "…" : "!"}</span><div><strong>${escapeHtml(gap.title)}</strong><p>${escapeHtml(gap.detail)}</p>${gap.ids ? `<div class="knowledge-gap-ids">${gap.ids}</div>` : ""}</div></article>`).join("")}</div></div>`
    : `<div class="knowledge-ready-message"><span>✓</span><div><strong>所有资料检查已通过</strong><p>分块、字幕覆盖、快照和输出契约都完整，Codex 可以开始核查与合成。</p></div></div>`;
  knowledgeChecks.innerHTML = `${checksMarkup}${gapsMarkup}`;
  $("#export-obsidian-button").disabled = knowledge.status !== "ready";
  $("#export-md-button").title = knowledge.status === "ready" ? "下载与 Obsidian 写入完全相同的总 MD" : "可下载带明显警告的草稿总 MD";
}

function renderNote() {
  if (!state.note) return;
  renderNoteHeader();
  renderPageOptions();
  renderTrackOptions();
  renderLeftPanel();
  renderTranscript();
  renderRecord();
  renderPlayer();
  renderAiControls();
  renderAnalysisScope();
  renderKnowledgeWorkflow();
  updateAIButtons();
}

async function openNote(noteId) {
  try {
    const payload = await api(`/api/notes/${encodeURIComponent(noteId)}`);
    state.note = payload.note;
    state.pageIndex = 0;
    state.trackIndex = 0;
    state.transcriptMode = "original";
    state.leftTab = "mindmap";
    state.analysisPageScope = "current";
    state.analysisTrackScope = "current";
    state.transcriptSearch = "";
    state.speakerFilter = "all";
    state.knowledgeDetailsOpen = false;
    state.knowledgeTranscriptMode = ["original", "speaker"].includes(state.note.knowledge?.material?.snapshot?.transcriptMode)
      ? state.note.knowledge.material.snapshot.transcriptMode
      : "polished";
    state.knowledgePreflightError = null;
    state.knowledgeTask = null;
    transcriptSearch.value = "";
    const polishedKey = analysisSourceKey(getSelectedPage(), getSelectedTrack());
    const polished = state.note.transcript?.polished;
    const hasCurrentPolished = polished?.status === "ready"
      && (polished.variants ? Boolean(polished.variants[polishedKey]?.segments?.length) : Boolean(polished.segments?.length));
    if (hasCurrentPolished) state.transcriptMode = "polished";
    $$(".left-tab").forEach((button) => button.classList.toggle("active", button.dataset.leftTab === "mindmap"));
    $$(".transcript-tab").forEach((button) => button.classList.toggle("active", button.dataset.transcriptMode === state.transcriptMode));
    setView("note");
    updateUrl(noteId);
    renderNote();
    await Promise.all([refreshAiEngines(), refreshAsrDiagnostics()]);
    await refreshGenerationStatuses();
    await refreshNoteTasks();
  } catch (error) {
    showToast(error.message, "error");
    await loadNotes();
  }
}

function closeNote() {
  if (state.recordSaveTimer) window.clearTimeout(state.recordSaveTimer);
  if (state.knowledgeTimer) window.clearInterval(state.knowledgeTimer);
  state.knowledgeTimer = null;
  state.knowledgeTask = null;
  state.note = null;
  state.activeTaskId = "";
  setView("library");
  updateUrl();
  loadNotes();
}

async function patchNote(body) {
  if (!state.note) return;
  const payload = await api(`/api/notes/${state.note.id}`, { method: "PATCH", body: JSON.stringify(body) });
  state.note = payload.note;
  state.notes = state.notes.map((item) => item.id === state.note.id ? payload.note : item);
  renderNotes();
  return payload.note;
}

async function toggleTag(tag) {
  const tags = (state.note.tags || []).filter((item) => item !== tag);
  await patchNote({ tags });
  renderTags();
}

async function addTag() {
  const value = window.prompt("输入标签");
  if (!value) return;
  const tags = [...new Set([...(state.note.tags || []), ...value.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean)])].slice(0, 20);
  await patchNote({ tags });
  renderTags();
}

function updateAIButtons() {
  const disabled = !state.note || !["api", "codex"].includes(noteEngineSelect.value);
  ["#polish-button", "#outline-button", "#mindmap-button", "#structure-button"].forEach((selector) => {
    $(selector).disabled = disabled || Boolean(state.activeTaskId);
  });
  renderAiControls();
  aiEngineStatus.textContent = noteEngineSelect.value === "codex"
    ? state.aiEngines?.codex?.installed ? "Codex 已连接" : "Codex 待配置"
    : state.aiEngines?.configured ? "API 已连接" : "未配置 AI";
  aiEngineStatus.dataset.ready = String(!disabled && (noteEngineSelect.value !== "codex" || state.aiEngines?.codex?.installed));
  renderAnalysisButtonStates();
  renderKnowledgeWorkflow();
  renderAsrButton();
  renderDiarizationButton();
}

function renderAsrButton() {
  if (!asrButton || !asrStatus) return;
  const status = state.note?.processing?.asr || "not_started";
  const labels = { not_started: "未运行", running: "转写中", ready: "已生成", failed: "失败" };
  asrStatus.textContent = labels[status] || (state.asrDiagnostics?.ready ? "可运行" : "待配置");
  asrStatus.dataset.generationStatus = status === "ready" ? "completed" : status === "running" ? "running" : status === "failed" ? "failed" : "not_generated";
  asrButton.disabled = !state.note || Boolean(state.activeTaskId) || state.asrDiagnostics?.ready === false;
  const diagnostics = state.asrDiagnostics;
  asrButton.title = diagnostics?.ready
    ? `${diagnostics.firstModelDownload ? "首次完整加载会下载或补全模型；" : "ASR 模型已完整缓存；"}当前 ${diagnostics.model} / ${diagnostics.vadModel} / ${diagnostics.puncModel} / ${diagnostics.device}`
    : diagnostics ? `缺少：${(diagnostics.missing || []).join("、")}。${diagnostics.hints?.install || ""}` : "正在检测本地 ASR 环境";
}

async function refreshAsrDiagnostics() {
  try {
    const payload = await api("/api/asr/status");
    state.asrDiagnostics = payload.diagnostics;
  } catch {
    state.asrDiagnostics = { ready: false, missing: ["diagnostics"] };
  }
  renderAsrButton();
  renderDiarizationButton();
}

async function runAsr() {
  if (!state.note || state.activeTaskId) return;
  const diagnostics = state.asrDiagnostics || (await refreshAsrDiagnostics(), state.asrDiagnostics);
  if (!diagnostics?.ready) {
    showToast(`本地 ASR 还不能运行：缺少 ${(diagnostics?.missing || []).join("、") || "运行环境"}。`, "error");
    return;
  }
  if (diagnostics.firstModelDownload && !window.confirm(`${diagnostics.hints?.firstDownload || "首次运行需要下载模型。"}\n\n确认后才会开始下载和转写。`)) return;
  let sessdata = "";
  let browserCookies = "";
  if (state.note.processing?.subtitle === "login_required") {
    sessdata = window.prompt("这个视频可能需要登录。可粘贴 SESSDATA（只用于本次音频下载，不保存）", "")?.trim() || "";
  }
  if (getSourceProvider() === "douyin" && state.note.media?.status !== "ready") {
    const useBrowser = window.confirm("抖音可能要求新鲜登录状态。\n\n确定：仅本次从 Chrome 读取抖音 Cookie，提高成功率。\n取消：先按公开访问尝试。");
    if (useBrowser) browserCookies = "chrome";
  }
  try {
    const payload = await api(`/api/notes/${state.note.id}/asr`, { method: "POST", body: JSON.stringify({ pageIndex: state.pageIndex, sessdata, browserCookies }) });
    state.activeTaskId = payload.task.id;
    state.note.processing = { ...(state.note.processing || {}), asr: "running" };
    showTaskProgress(payload.task);
    updateAIButtons();
    await pollTask(payload.task.id);
  } catch (error) {
    state.activeTaskId = "";
    showToast(error.message, "error");
    await refreshAsrDiagnostics();
    updateAIButtons();
  }
}

function renderDiarizationButton() {
  if (!diarizationButton || !diarizationStatus) return;
  const status = state.note?.processing?.diarization || "not_started";
  const labels = { not_started: "未运行", running: "识别中", ready: "已生成", failed: "失败" };
  diarizationStatus.textContent = labels[status] || "未运行";
  diarizationStatus.dataset.generationStatus = status === "ready" ? "completed" : status === "running" ? "running" : status === "failed" ? "failed" : "not_generated";
  const hasText = getOriginalSegments().length > 0;
  diarizationButton.disabled = !state.note || !hasText || Boolean(state.activeTaskId) || state.asrDiagnostics?.ready === false;
  diarizationButton.title = !hasText
    ? "当前轨道没有文字，无法生成说话人版"
    : state.asrDiagnostics?.firstSpeakerModelDownload
      ? "首次主动运行会下载 CAM++ 模型；不会自动启动"
      : `当前使用 ${state.asrDiagnostics?.speakerModel || "cam++"}；只在主动点击后运行`;
}

async function runDiarization() {
  if (!state.note || state.activeTaskId) return;
  const diagnostics = state.asrDiagnostics || (await refreshAsrDiagnostics(), state.asrDiagnostics);
  if (!diagnostics?.ready) {
    showToast(`说话人识别还不能运行：缺少 ${(diagnostics?.missing || []).join("、") || "运行环境"}。`, "error");
    return;
  }
  if (!getOriginalSegments().length) {
    showToast("当前字幕轨道没有文字，请先获取字幕或运行 ASR。", "error");
    return;
  }
  const confirmation = diagnostics.firstSpeakerModelDownload
    ? `${diagnostics.hints?.firstSpeakerDownload || "首次说话人识别需要下载 CAM++ 模型。"}\n\n这项功能不会调用 LLM，也不会覆盖原文或 AI 润色版。确认启动吗？`
    : "说话人识别只会在本机运行，并生成独立的“说话人版”，不会覆盖原文或 AI 润色版。确认启动吗？";
  if (!window.confirm(confirmation)) return;
  let sessdata = "";
  let browserCookies = "";
  if (!state.note.asr?.audioPath && state.note.processing?.subtitle === "login_required") {
    sessdata = window.prompt("音频下载可能需要登录。可粘贴 SESSDATA（只用于本次请求，不保存）", "")?.trim() || "";
  }
  if (!state.note.asr?.audioPath && !state.note.media?.videoPath && getSourceProvider() === "douyin") {
    const useBrowser = window.confirm("说话人识别需要先取得抖音媒体。是否允许本次从 Chrome 读取抖音 Cookie？");
    if (useBrowser) browserCookies = "chrome";
  }
  try {
    const payload = await api(`/api/notes/${state.note.id}/diarization`, {
      method: "POST",
      body: JSON.stringify({ pageIndex: state.pageIndex, trackIndex: state.trackIndex, sessdata, browserCookies })
    });
    state.activeTaskId = payload.task.id;
    state.note.processing = { ...(state.note.processing || {}), diarization: "running" };
    showTaskProgress(payload.task);
    updateAIButtons();
    await pollTask(payload.task.id);
  } catch (error) {
    state.activeTaskId = "";
    showToast(error.message, "error");
    updateAIButtons();
  }
}

async function renameSpeaker(speakerId) {
  if (!state.note || !speakerId) return;
  const current = state.note.speaker?.labels?.[speakerId] || speakerId;
  const label = window.prompt("说话人名称", current)?.trim();
  if (!label || label === current) return;
  try {
    const payload = await api(`/api/notes/${state.note.id}/speakers`, { method: "PATCH", body: JSON.stringify({ speakerId, label }) });
    state.note = payload.note;
    renderTranscript();
    showToast("说话人名称已保存", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function refreshAiEngines() {
  try {
    const payload = await api("/api/ai/engines");
    state.aiEngines = payload.engines;
    renderAiControls();
    updateAIButtons();
  } catch {
    state.aiEngines = null;
    renderAiControls();
    updateAIButtons();
  }
}

async function runAnalysis(operation) {
  if (!state.note) return;
  const engine = noteEngineSelect.value;
  if (!["api", "codex"].includes(engine)) {
    showToast("请先选择普通 API 或 Codex 作为处理引擎。", "error");
    return;
  }
  if (engine === "codex" && state.aiEngines && !state.aiEngines.codex?.installed) {
    showToast("当前没有检测到 Codex CLI，请先启动 AI 底座并完成 Codex 登录。", "error");
    return;
  }
  const provider = noteProviderSelect.value;
  const model = noteModelSelect.value;
  const pageScope = analysisPageScopeSelect.value === "all" ? "all" : "current";
  const trackScope = analysisTrackScopeSelect.value === "all" ? "all" : "current";
  const sources = getAnalysisSources();
  const totalSegments = sources.reduce((sum, source) => sum + source.segments.length, 0);
  if (!sources.length || !totalSegments) {
    showToast("当前处理范围没有可用字幕。", "error");
    return;
  }
  const requestBody = {
    operation,
    engine,
    provider,
    model,
    pageIndex: state.pageIndex,
    trackIndex: state.trackIndex,
    pageScope,
    trackScope
  };
  try {
    if (operation === "polish" && engine === "api") {
      const previewPayload = await api(`/api/notes/${state.note.id}/analysis`, {
        method: "POST",
        body: JSON.stringify({ ...requestBody, previewOnly: true })
      });
      const preview = previewPayload.preview;
      const warning = `本次 AI 润色将处理 ${preview.segmentCount} 条字幕，系统已建立 ${preview.editBlockCount} 个连续编辑段落。\n\n预计调用 API：${preview.apiRequestCount} 次\n预计完整请求：约 ${preview.inputTokens} tokens\n预计完整输出：约 ${preview.expectedOutputTokens} tokens\n\n模型必须逐段等量润色；系统会核查段落数量、逐段内容保留率、标点密度和全文长度。只有点击“确定”后才正式产生调用。是否继续？`;
      if (!window.confirm(warning)) return;
    }
    const payload = await api(`/api/notes/${state.note.id}/analysis`, {
      method: "POST",
      body: JSON.stringify(requestBody)
    });
    state.activeTaskId = payload.task.id;
    setGenerationStatus(operation, "running", { startedAt: Date.now(), taskId: payload.task.id });
    if (operation === "structure") {
      setGenerationStatus("outline", "running", { startedAt: Date.now(), taskId: payload.task.id });
      setGenerationStatus("mindmap", "running", { startedAt: Date.now(), taskId: payload.task.id });
    }
    transcriptState.hidden = false;
    transcriptState.innerHTML = `<div class="state-mark loading-state-mark">◌</div><strong>正在处理 ${escapeHtml(operationLabel(operation))}</strong><p id="task-progress-copy">${escapeHtml(pageScope === "all" || trackScope === "all" ? `将处理 ${sources.length} 条轨道，共 ${totalSegments} 段` : `将处理当前轨道，共 ${totalSegments} 段`)} · 任务已排队…</p>`;
    updateAIButtons();
    await pollTask(payload.task.id);
  } catch (error) {
    showToast(error.message, "error");
    state.activeTaskId = "";
    setGenerationStatus(operation, "failed", { failedAt: Date.now() });
    updateAIButtons();
  }
}

async function runKnowledgeMaterials() {
  if (!state.note || state.activeTaskId) return;
  if (!state.aiEngines?.configured) {
    showToast("普通 API 还没有连接，请先在设置中配置 AI 底座。", "error");
    return;
  }
  const pageScope = analysisPageScopeSelect.value === "current" ? "current" : "all";
  const trackScope = analysisTrackScopeSelect.value === "all" ? "all" : "current";
  const transcriptMode = ["original", "speaker"].includes(knowledgeTranscriptMode.value) ? knowledgeTranscriptMode.value : "polished";
  const transcriptModeLabel = transcriptMode === "speaker" ? "说话人版" : transcriptMode === "original" ? "原文" : "AI 润色版";
  const requestBody = {
    pageIndex: state.pageIndex, trackIndex: state.trackIndex, pageScope, trackScope,
    transcriptMode, provider: noteProviderSelect.value, model: noteModelSelect.value
  };
  let preview;
  try {
    const payload = await api(`/api/notes/${state.note.id}/knowledge/preview`, {
      method: "POST",
      body: JSON.stringify(requestBody)
    });
    preview = payload.preview;
  } catch (error) {
    state.knowledgePreflightError = { code: error.code, message: error.message, details: error.details || {} };
    renderKnowledgeWorkflow();
    showToast(error.message, "error");
    return;
  }
  const warning = `API 将处理${pageScope === "all" ? "全部 P" : "当前 P"}的${trackScope === "all" ? "全部字幕轨道" : "选定轨道"}，使用${transcriptModeLabel}。\n\n源字幕：${preview.sourceSegmentCount} 条\n知识段落：${preview.knowledgeSegmentCount} 段\n预计 API 请求：${preview.chunkCount} 次（后端硬上限 5 次）\n预计总输入：约 ${preview.inputTokens} tokens\n\n这是正式付费调用前的最后确认。超过 5 次时系统会直接停止，不会自动继续扣费。所有分块完整前，Codex 始终不会启动。确认开始吗？`;
  if (!window.confirm(warning)) return;
  state.knowledgeTask = {
    operation: "knowledge_extract", status: "submitting", taskId: "", startedAt: Date.now(), progress: 0,
    message: "正在检查字幕范围并建立 API 分块任务。", metrics: {}, error: null
  };
  renderKnowledgeWorkflow();
  try {
    state.knowledgePreflightError = null;
    const payload = await api(`/api/notes/${state.note.id}/knowledge/materials`, {
      method: "POST",
      body: JSON.stringify(requestBody)
    });
    state.activeTaskId = payload.task.id;
    syncKnowledgeTask(payload.task);
    setGenerationStatus("knowledge_extract", "running", { startedAt: Date.now(), taskId: payload.task.id });
    showTaskProgress(payload.task);
    updateAIButtons();
    await pollTask(payload.task.id);
  } catch (error) {
    state.activeTaskId = "";
    state.knowledgeTask = {
      ...(state.knowledgeTask || {}), operation: "knowledge_extract", status: "failed", progress: 0,
      message: error.message, error: { code: error.code, message: error.message }, metrics: state.knowledgeTask?.metrics || {}
    };
    state.knowledgePreflightError = { code: error.code, message: error.message, details: error.details || {} };
    state.knowledgeDetailsOpen = true;
    showToast(error.message, "error");
    updateAIButtons();
  }
}

async function runKnowledgeSynthesis() {
  if (!state.note || state.activeTaskId) return;
  const completeness = state.note.knowledge?.material?.completeness;
  if (!completeness?.ready) {
    showToast("API 资料还没有 100% 完整，Codex 不会启动。", "error");
    return;
  }
  if (!window.confirm("Codex 将只读完整资料快照，先审计，再合成总输出。\n\n如果审计不通过，它只会列问题，不会生成正式笔记。确认开始吗？")) return;
  state.knowledgeTask = {
    operation: "knowledge_synthesize", status: "submitting", taskId: "", startedAt: Date.now(), progress: 0,
    message: "正在锁定完整资料包并提交 Codex 核查。", metrics: {}, error: null
  };
  renderKnowledgeWorkflow();
  try {
    const payload = await api(`/api/notes/${state.note.id}/knowledge/synthesize`, { method: "POST", body: JSON.stringify({}) });
    state.activeTaskId = payload.task.id;
    syncKnowledgeTask(payload.task);
    setGenerationStatus("knowledge_synthesize", "running", { startedAt: Date.now(), taskId: payload.task.id });
    showTaskProgress(payload.task);
    updateAIButtons();
    await pollTask(payload.task.id);
  } catch (error) {
    state.activeTaskId = "";
    state.knowledgeTask = {
      ...(state.knowledgeTask || {}), operation: "knowledge_synthesize", status: "failed", progress: 0,
      message: error.message, error: { code: error.code, message: error.message }, metrics: state.knowledgeTask?.metrics || {}
    };
    showToast(error.message, "error");
    updateAIButtons();
  }
}

async function retryAnalysisTask(taskId) {
  if (!taskId || state.activeTaskId) return;
  try {
    const payload = await api(`/api/tasks/${taskId}/retry`, { method: "POST", body: "{}" });
    const task = payload.task;
    state.activeTaskId = task.id;
    setGenerationStatus(task.meta?.operation, "running", { startedAt: Date.now(), taskId: task.id, scope: { pageScope: task.meta?.pageScope, trackScope: task.meta?.trackScope } });
    showTaskProgress(task);
    updateAIButtons();
    await pollTask(task.id);
    if (generationLogDialog?.open) await openGenerationLogs();
  } catch (error) {
    state.activeTaskId = "";
    showToast(error.message, "error");
    updateAIButtons();
  }
}

function operationLabel(operation) {
  return { polish: "AI润色", outline: "文字大纲", mindmap: "思维导图", structure: "大纲+导图（并行）", knowledge_extract: "API 知识资料整理", knowledge_synthesize: "Codex 核查合成", asr: "本地 ASR", diarization: "说话人识别" }[operation] || "AI任务";
}

function taskStatusLabel(status) {
  return {
    queued: "排队中",
    running: "生成中",
    completed: "已完成",
    failed: "失败",
    interrupted: "已中断",
    crashed: "异常中断"
  }[status] || status || "未知状态";
}

function generationEventLabel(event) {
  return {
    submitted: "任务已提交",
    started: "开始处理",
    progress: "处理进度",
    completed: "处理完成",
    failed: "处理失败",
    retried: "重试未完成步骤",
    interrupted: "任务中断",
    crashed: "异常中断",
    snapshot: "任务快照"
  }[event] || event || "状态更新";
}

function renderGenerationLogs() {
  if (!generationLogList) return;
  if (!state.generationLogs.length) {
    generationLogList.innerHTML = `<div class="generation-log-empty"><span>—</span><strong>还没有生成记录</strong><p>AI 润色、大纲、导图、API 资料整理和 Codex 合成都会自动记录在这里。</p></div>`;
    return;
  }
  generationLogList.innerHTML = state.generationLogs.map((log) => {
    const result = log.result || {};
    const metrics = log.metrics || result.metrics || {};
    const detail = result.segmentCount ? `处理 ${result.segmentCount} 段字幕` : log.message || "未返回结果摘要";
    const scope = `${log.pageScope === "all" ? "全部 P" : "当前 P"} / ${log.trackScope === "all" ? "全部轨道" : "当前轨道"}`;
    const events = (log.events || []).map((event) => `<li><span>${escapeHtml(generationEventLabel(event.event))}</span><span>${escapeHtml(event.message || taskStatusLabel(event.status))}${event.event === "progress" ? ` · ${Number(event.progress || 0)}%` : ""}</span><time>${escapeHtml(formatDate(event.createdAt))}</time></li>`).join("");
    const retryLabel = log.error?.code === "AI_PARTIAL_STRUCTURE" && Number(metrics.failedChunkCount || 0) === 0
      ? "重试全局合并 ↗"
      : "只重试失败分块 ↗";
    return `<article class="generation-log-item" data-status="${escapeHtml(log.status)}">
      <div class="generation-log-head"><strong>${escapeHtml(operationLabel(log.operation))}</strong><span class="generation-log-status">${escapeHtml(taskStatusLabel(log.status))}</span></div>
      <div class="generation-log-meta">${escapeHtml(log.engine || "普通 API")} · ${escapeHtml(log.provider || "底座默认平台")} · ${escapeHtml(log.model || "底座默认模型")}</div>
      <div class="generation-log-meta">${escapeHtml(scope)} · ${escapeHtml(detail)}</div>
      <div class="generation-log-meta">分块 ${Number(metrics.completedChunkCount || 0)}/${Number(metrics.chunkCount || 0)} · 输入 ${Number(metrics.inputChars || 0)} 字 · ${Number(metrics.receivedOutputChars || 0) > Number(metrics.outputChars || 0) ? `API 返回 ${Number(metrics.receivedOutputChars)} 字 / 本地接纳 ${Number(metrics.outputChars || 0)} 字` : `输出 ${Number(metrics.outputChars || 0)} 字`} · 耗时 ${formatElapsed(Number(metrics.elapsedMs || 0))}${Number(metrics.failedChunkCount || 0) ? ` · 失败 ${Number(metrics.failedChunkCount)} 块` : ""}</div>
      <div class="generation-log-time">${escapeHtml(formatDate(log.updatedAt || log.createdAt))} · ${escapeHtml(log.taskId || "")}</div>
      ${log.error?.message ? `<p class="generation-log-error">${escapeHtml(log.error.message)}</p>` : ""}
      ${log.retryable ? `<button class="structure-generate log-retry-button" data-retry-task="${escapeHtml(log.taskId || "")}" type="button">${retryLabel}</button>` : ""}
      ${events ? `<details><summary>查看处理过程（${log.eventCount || 0} 条）</summary><ul>${events}</ul></details>` : ""}
    </article>`;
  }).join("");
}

async function openGenerationLogs() {
  if (!state.note || !generationLogDialog) return;
  generationLogList.innerHTML = `<div class="generation-log-loading">正在读取生成日志…</div>`;
  if (!generationLogDialog.open) generationLogDialog.showModal();
  try {
    state.generationLogRefreshAt = Date.now();
    const payload = await api(`/api/notes/${state.note.id}/logs`);
    state.generationLogs = payload.logs || [];
    applyGenerationLogStatuses(state.generationLogs);
    renderGenerationLogs();
  } catch (error) {
    generationLogList.innerHTML = `<div class="generation-log-empty"><span>!</span><strong>日志读取失败</strong><p>${escapeHtml(error.message)}</p></div>`;
  }
}

async function refreshOpenGenerationLogs() {
  if (!generationLogDialog?.open || !state.note || Date.now() - state.generationLogRefreshAt < 2000) return;
  state.generationLogRefreshAt = Date.now();
  try {
    const payload = await api(`/api/notes/${state.note.id}/logs`);
    state.generationLogs = payload.logs || [];
    renderGenerationLogs();
  } catch {
    // 轮询日志失败不影响主任务；下次轮询继续尝试。
  }
}

function operationEventLabel(event) {
  return {
    note_created: "创建笔记", note_reopened: "重新打开笔记", note_opened: "打开笔记", note_restored_by_reopen: "重新打开并恢复",
    subtitle_refreshed: "获取或刷新字幕", note_metadata_updated: "修改笔记信息", record_saved: "保存我的记录", record_conflict: "记录保存冲突",
    ai_task_submitted: "提交 AI 任务", ai_task_started: "AI 任务开始", ai_task_retried: "重试失败分块", ai_task_completed: "AI 任务完成",
    ai_task_failed: "AI 任务失败", ai_task_interrupted: "AI 任务中断", markdown_exported: "导出 Markdown", obsidian_preview_created: "Obsidian 写入预览",
    obsidian_write_confirmed: "确认 Obsidian 写入", obsidian_write_succeeded: "Obsidian 写入成功", obsidian_write_failed: "Obsidian 写入失败",
    note_soft_deleted: "移入回收站", note_restored: "恢复笔记",
    asr_task_submitted: "提交本地 ASR", asr_task_started: "本地 ASR 开始", asr_task_completed: "本地 ASR 完成",
    asr_task_failed: "本地 ASR 失败", asr_task_interrupted: "本地 ASR 中断", asr_task_crashed: "本地 ASR 异常中断",
    diarization_task_submitted: "提交说话人识别", diarization_task_started: "说话人识别开始", diarization_task_completed: "说话人识别完成",
    diarization_task_failed: "说话人识别失败", diarization_task_interrupted: "说话人识别中断", diarization_task_crashed: "说话人识别异常中断",
    speaker_label_updated: "修改说话人名称"
  }[event] || event || "未知操作";
}

function renderOperationLogs() {
  if (!activityLogList) return;
  if (!state.operationLogs.length) {
    activityLogList.innerHTML = `<div class="generation-log-empty"><span>—</span><strong>当前范围没有操作记录</strong><p>日志按时间保存在本机，不包含 SESSDATA、API Key 或完整提示词。</p></div>`;
    return;
  }
  activityLogList.innerHTML = state.operationLogs.map((log) => {
    const details = Object.entries(log.details || {}).map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`).join(" · ");
    return `<article class="generation-log-item"><div class="generation-log-head"><strong>${escapeHtml(operationEventLabel(log.event))}</strong><span class="generation-log-status">${escapeHtml(log.noteId || "全局")}</span></div><div class="generation-log-time">${escapeHtml(formatDate(log.createdAt))}</div>${details ? `<div class="generation-log-meta">${escapeHtml(details)}</div>` : ""}</article>`;
  }).join("");
}

async function loadOperationLogs() {
  activityLogList.innerHTML = `<div class="generation-log-loading">正在读取本地操作日志…</div>`;
  const params = new URLSearchParams({ limit: "300" });
  if (state.operationLogScope === "note" && state.note?.id) params.set("noteId", state.note.id);
  const from = $("#activity-log-from").value;
  const to = $("#activity-log-to").value;
  if (from) params.set("from", new Date(from).toISOString());
  if (to) params.set("to", new Date(to).toISOString());
  try {
    const payload = await api(`/api/logs?${params.toString()}`);
    state.operationLogs = payload.operations || [];
    renderOperationLogs();
  } catch (error) {
    activityLogList.innerHTML = `<div class="generation-log-empty"><span>!</span><strong>操作日志读取失败</strong><p>${escapeHtml(error.message)}</p></div>`;
  }
}

async function openOperationLogs() {
  if (!activityLogDialog) return;
  if (!activityLogDialog.open) activityLogDialog.showModal();
  await loadOperationLogs();
}

async function pollTask(taskId) {
  while (state.activeTaskId === taskId) {
    const payload = await api(`/api/tasks/${taskId}`);
    const task = payload.task;
    syncKnowledgeTask(task);
    renderKnowledgeWorkflow();
    await refreshOpenGenerationLogs();
    const progressCopy = $("#task-progress-copy");
    const metrics = task.metrics || {};
    if (progressCopy) progressCopy.textContent = ["asr", "diarization"].includes(task.type)
      ? `${task.message || "正在处理"} · ${task.progress || 0}% · 阶段 ${task.meta?.stage || "准备"}`
      : `${task.message || "正在处理"} · ${task.progress || 0}% · 分块 ${Number(metrics.completedChunkCount || 0)}/${Number(metrics.chunkCount || 0)}`;
    if (["completed", "failed", "interrupted"].includes(task.status)) {
      state.activeTaskId = "";
      const operation = task.meta?.operation;
      if (task.status === "completed") {
        const refreshed = await api(`/api/notes/${state.note.id}`);
        state.note = refreshed.note;
        if (task.type === "asr") {
          state.transcriptMode = "original";
          state.pageIndex = Number(task.meta?.pageIndex || 0);
          const page = state.note.transcript?.original?.pages?.[state.pageIndex];
          const asrIndex = (page?.subtitles || []).findIndex((track) => track.source === "funasr");
          if (asrIndex >= 0) state.trackIndex = asrIndex;
        } else if (task.type === "diarization") {
          state.transcriptMode = "speaker";
          state.pageIndex = Number(task.meta?.pageIndex || 0);
          state.trackIndex = Number(task.meta?.trackIndex || 0);
        } else if (operation === "polish") {
          state.transcriptMode = "polished";
        }
        if (operation === "structure") {
          state.leftTab = "mindmap";
          $$(".left-tab").forEach((button) => button.classList.toggle("active", button.dataset.leftTab === state.leftTab));
          setGenerationStatus("outline", "completed");
          setGenerationStatus("mindmap", "completed");
        }
        if (task.type === "analysis") setGenerationStatus(operation, "completed");
        renderNote();
        if (operation === "knowledge_synthesize" && task.result?.auditStatus === "BLOCKED") {
          showToast("Codex 审计未通过，已阻止正式合成。", "error");
        } else if (operation === "knowledge_extract") {
          showToast("API 资料已 100% 完整，Codex 现在可以启动。", "success");
        } else {
          showToast(`${operationLabel(operation)}已完成${operation === "knowledge_synthesize" ? "，总 MD 已就绪" : "，已切换到结果"}`, "success");
        }
      } else {
        if (["asr", "diarization"].includes(task.type)) {
          const refreshed = await api(`/api/notes/${state.note.id}`);
          state.note = refreshed.note;
          renderNote();
          transcriptState.hidden = false;
          const isDiarization = task.type === "diarization";
          transcriptState.innerHTML = `<div class="state-mark">!</div><strong>${isDiarization ? "说话人识别" : "本地 ASR"}没有完成</strong><p>失败阶段：${escapeHtml(task.meta?.stage || "未知")}。${escapeHtml(task.error?.message || task.message || "请检查本机环境")}</p><button class="structure-generate" ${isDiarization ? "data-start-diarization" : "data-start-asr"} type="button">重新启动${isDiarization ? "说话人识别" : " ASR"} ↗</button>`;
          showToast(task.error?.message || `${isDiarization ? "说话人识别" : "本地 ASR"}失败`, "error");
          updateAIButtons();
          return;
        }
        const completedChunks = Number(task.metrics?.completedChunkCount || 0);
        const failedChunks = Number(task.metrics?.failedChunkCount || 0);
        const partialGenerated = task.error?.details?.generated || [];
        setGenerationStatus(operation, "failed", { failedAt: Date.now(), taskId });
        partialGenerated.forEach((generatedOperation) => setGenerationStatus(generatedOperation, "completed"));
        (task.error?.details?.failed || []).forEach((failedOperation) => {
          const failedName = typeof failedOperation === "string" ? failedOperation : failedOperation.operation;
          if (failedName) setGenerationStatus(failedName, "failed", { failedAt: Date.now(), taskId });
        });
        if (partialGenerated.length || completedChunks || ["knowledge_extract", "knowledge_synthesize"].includes(operation)) {
          const refreshed = await api(`/api/notes/${state.note.id}`);
          state.note = refreshed.note;
          renderNote();
        }
        transcriptState.hidden = false;
        const retryLabel = task.error?.code === "AI_PARTIAL_STRUCTURE" && failedChunks === 0
          ? "重试全局合并 ↗"
          : "只重试失败分块 ↗";
        transcriptState.innerHTML = `<div class="state-mark">!</div><strong>${partialGenerated.length || completedChunks ? "任务部分完成" : "任务没有完成"}</strong><p>${escapeHtml(task.error?.message || task.message || "请稍后重试")} ${failedChunks ? `失败 ${failedChunks} 个分块，成功结果已保留。` : ""}</p><button class="structure-generate" data-retry-task="${escapeHtml(task.id)}" type="button">${retryLabel}</button>`;
        showToast(task.error?.message || "AI 任务失败", "error");
        updateAIButtons();
      }
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 850));
  }
}

async function saveRecord() {
  if (!state.note || state.recordSaving) return;
  state.recordSaving = true;
  recordStatus.textContent = "保存中…";
  try {
    const html = recordEditor.innerHTML;
    const plainText = recordEditor.innerText.trim();
    const payload = await api(`/api/notes/${state.note.id}/record`, {
      method: "PUT",
      body: JSON.stringify({ html, plainText, revision: Number(state.note.record?.revision || 0) })
    });
    state.note.record = payload.record;
    state.note.updatedAt = payload.note.updatedAt;
    state.notes = state.notes.map((item) => item.id === state.note.id ? payload.note : item);
    recordStatus.textContent = `已保存 ${formatDate(payload.record.updatedAt)}`;
  } catch (error) {
    recordStatus.textContent = "保存失败";
    showToast(error.message, "error");
  } finally {
    state.recordSaving = false;
  }
}

function scheduleRecordSave() {
  recordStatus.textContent = "有未保存修改";
  if (state.recordSaveTimer) window.clearTimeout(state.recordSaveTimer);
  state.recordSaveTimer = window.setTimeout(saveRecord, 700);
}

function execRecordCommand(command, value = null) {
  recordEditor.focus();
  try {
    document.execCommand(command, false, value);
  } catch {
    // The browser can reject a command when there is no active selection.
  }
  scheduleRecordSave();
}

async function exportToObsidian() {
  if (!state.note) return;
  try {
    const payload = await api("/api/codex/file-tasks/preview", {
      method: "POST",
      body: JSON.stringify({ noteId: state.note.id, operation: "sync_obsidian" })
    });
    const plan = payload.task.plan;
    const accepted = window.confirm(`将${plan.action === "update" ? "更新" : "创建"}文件：\n${plan.targetPath}\n\n大小：${formatBytes(plan.bytes)}\n\n确认写入 Obsidian 吗？`);
    if (!accepted) return;
    const result = await api(`/api/codex/file-tasks/${payload.task.id}/confirm`, { method: "POST", body: "{}" });
    showToast(result.task.result?.targetPath ? `已写入：${result.task.result.targetPath}` : "Obsidian 写入完成", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function deleteCurrentNote() {
  if (!state.note) return;
  if (!window.confirm("删除这条笔记？它会进入删除状态，不会立刻清除文件。")) return;
  try {
    await api(`/api/notes/${state.note.id}`, { method: "DELETE" });
    showToast("笔记已移到删除状态", "success");
    closeNote();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function handleCardAction(event) {
  const button = event.target.closest("button[data-card-action]");
  const card = event.target.closest("[data-note-id]");
  if (!card) return;
  const noteId = card.dataset.noteId;
  if (button) {
    event.stopPropagation();
    const item = state.notes.find((note) => note.id === noteId);
    if (!item) return;
    if (button.dataset.cardAction === "pin") {
      await api(`/api/notes/${noteId}`, { method: "PATCH", body: JSON.stringify({ pinned: !item.pinned }) });
      await loadNotes();
      return;
    }
    if (button.dataset.cardAction === "delete") {
      if (!window.confirm("删除这条笔记？")) return;
      await api(`/api/notes/${noteId}`, { method: "DELETE" });
      await loadNotes();
      showToast("笔记已移到删除状态", "success");
      return;
    }
    if (button.dataset.cardAction === "restore") {
      await api(`/api/notes/${noteId}/restore`, { method: "POST", body: "{}" });
      await loadNotes();
      showToast("笔记已从回收站恢复", "success");
      return;
    }
  }
  const item = state.notes.find((note) => note.id === noteId);
  if (item?.deletedAt) {
    showToast("请先点击“恢复”，再打开这条笔记。", "error");
    return;
  }
  await openNote(noteId);
}

async function saveSettings(event) {
  if (event.submitter?.id !== "settings-save") return;
  event.preventDefault();
  settingsMessage.hidden = true;
  try {
    const payload = await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({
        aiBaseUrl: $("#settings-ai-base").value.trim(),
        obsidianVaultPath: $("#settings-vault").value.trim(),
        obsidianFolder: $("#settings-folder").value.trim(),
        asrPythonPath: $("#settings-asr-python").value.trim(),
        asrModelDir: $("#settings-asr-model-dir").value.trim(),
        asrModel: $("#settings-asr-model").value.trim(),
        asrVadModel: $("#settings-asr-vad").value.trim(),
        asrPuncModel: $("#settings-asr-punc").value.trim(),
        speakerModel: $("#settings-speaker-model").value.trim(),
        asrDevice: $("#settings-asr-device").value,
        asrCpuThreads: Number($("#settings-asr-threads").value || 4),
        speakerMergeGapSeconds: Number($("#settings-speaker-gap").value || 1.5),
        speakerMaxSegmentSeconds: Number($("#settings-speaker-max").value || 20)
      })
    });
    state.settings = payload.settings;
    settingsDialog.close();
    await Promise.all([refreshAiEngines(), refreshAsrDiagnostics()]);
    showToast("本机设置已保存", "success");
  } catch (error) {
    settingsMessage.hidden = false;
    settingsMessage.textContent = error.message;
  }
}

async function openSettings() {
  try {
    const payload = await api("/api/settings");
    state.settings = payload.settings;
    $("#settings-ai-base").value = state.settings.aiBaseUrl || "";
    $("#settings-vault").value = state.settings.obsidianVaultPath || "";
    $("#settings-folder").value = state.settings.obsidianFolder || "视频笔记";
    $("#settings-asr-python").value = state.settings.asrPythonPath || "";
    $("#settings-asr-model-dir").value = state.settings.asrModelDir || "";
    $("#settings-asr-model").value = state.settings.asrModel || "paraformer-zh";
    $("#settings-asr-vad").value = state.settings.asrVadModel || "fsmn-vad";
    $("#settings-asr-punc").value = state.settings.asrPuncModel || "ct-punc";
    $("#settings-speaker-model").value = state.settings.speakerModel || "cam++";
    $("#settings-asr-device").value = state.settings.asrDevice || "cpu";
    $("#settings-asr-threads").value = String(state.settings.asrCpuThreads || 4);
    $("#settings-speaker-gap").value = String(state.settings.speakerMergeGapSeconds || 1.5);
    $("#settings-speaker-max").value = String(state.settings.speakerMaxSegmentSeconds || 20);
    await refreshAsrDiagnostics();
    const diagnostics = state.asrDiagnostics;
    $("#settings-asr-diagnostics").textContent = diagnostics?.ready
      ? `环境可用 · ${diagnostics.runtime?.funasr || "FunASR"} · ${diagnostics.runtime?.torch ? `PyTorch ${diagnostics.runtime.torch}` : "PyTorch"} · ${diagnostics.firstModelDownload ? "ASR 模型尚未完整缓存" : "ASR 模型已完整缓存"} · ${diagnostics.firstSpeakerModelDownload ? "CAM++ 尚未完整缓存" : "CAM++ 已完整缓存"}`
      : `环境未就绪：缺少 ${(diagnostics?.missing || []).join("、") || "未知组件"}。${diagnostics?.hints?.install || ""}`;
    settingsMessage.hidden = true;
    settingsDialog.showModal();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function initRecordToolbar() {
  $$("#record-toolbar button[data-command]").forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => execRecordCommand(button.dataset.command));
  });
  $("#record-format").addEventListener("change", (event) => execRecordCommand("formatBlock", event.target.value));
  $("#record-size").addEventListener("change", (event) => execRecordCommand("fontSize", event.target.value));
  $("#record-color").addEventListener("input", (event) => execRecordCommand("foreColor", event.target.value));
  $("#record-highlight").addEventListener("input", (event) => execRecordCommand("hiliteColor", event.target.value));
  recordEditor.addEventListener("input", scheduleRecordSave);
}

function bindEvents() {
  noteForm.addEventListener("submit", createNote);
  mediaUploadInput.addEventListener("change", () => uploadLocalMedia(mediaUploadInput.files?.[0]));
  const playerWrap = $(".player-frame-wrap");
  playerWrap.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; });
  playerWrap.addEventListener("drop", (event) => {
    event.preventDefault();
    uploadLocalMedia(event.dataTransfer.files?.[0]);
  });
  localPlayer.addEventListener("timeupdate", () => {
    if (!localPlayer.hidden) playerTime.textContent = formatTime(localPlayer.currentTime);
  });
  notesSearch.addEventListener("input", () => { state.notesSearch = notesSearch.value; renderNotes(); });
  notesList.addEventListener("click", handleCardAction);
  $$(".filter-button[data-filter]").forEach((button) => button.addEventListener("click", () => {
    state.notesFilter = button.dataset.filter;
    $$(".filter-button[data-filter]").forEach((item) => item.classList.toggle("active", item === button));
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.id === (state.notesFilter === "pending" ? "nav-pending-button" : state.notesFilter === "deleted" ? "nav-trash-button" : state.notesFilter === "all" ? "nav-all-button" : "")));
    renderNotes();
  }));
  $("#nav-all-button").addEventListener("click", () => {
    state.notesFilter = "all";
    $$(".filter-button[data-filter]").forEach((item) => item.classList.toggle("active", item.dataset.filter === "all"));
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.id === "nav-all-button"));
    renderNotes();
  });
  $("#nav-pending-button").addEventListener("click", () => {
    state.notesFilter = "pending";
    $$(".filter-button[data-filter]").forEach((item) => item.classList.toggle("active", item.dataset.filter === "pending"));
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.id === "nav-pending-button"));
    renderNotes();
  });
  $("#nav-trash-button").addEventListener("click", () => {
    state.notesFilter = "deleted";
    $$(".filter-button[data-filter]").forEach((item) => item.classList.toggle("active", item.dataset.filter === "deleted"));
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.id === "nav-trash-button"));
    renderNotes();
  });
  $("#brand-button").addEventListener("click", closeNote);
  $("#back-to-library").addEventListener("click", closeNote);
  $("#settings-button").addEventListener("click", openSettings);
  $("#activity-log-button").addEventListener("click", openOperationLogs);
  $("#activity-log-close").addEventListener("click", () => activityLogDialog.close());
  $("#activity-log-refresh").addEventListener("click", loadOperationLogs);
  $$("[data-log-scope]").forEach((button) => button.addEventListener("click", () => {
    state.operationLogScope = button.dataset.logScope === "note" && state.note ? "note" : "all";
    $$("[data-log-scope]").forEach((item) => item.classList.toggle("active", item.dataset.logScope === state.operationLogScope));
    loadOperationLogs();
  }));
  settingsForm.addEventListener("submit", saveSettings);
  $("#generation-log-button").addEventListener("click", openGenerationLogs);
  $("#knowledge-task-log-button").addEventListener("click", openGenerationLogs);
  $("#generation-log-close").addEventListener("click", () => generationLogDialog.close());
  generationLogList.addEventListener("click", (event) => {
    const retry = event.target.closest("[data-retry-task]");
    if (retry) retryAnalysisTask(retry.dataset.retryTask);
  });
  $("#mindmap-dialog-close").addEventListener("click", () => mindmapDialog.close());
  $("#note-title").addEventListener("change", async () => {
    try { await patchNote({ title: noteTitle.value }); showToast("标题已保存", "success"); } catch (error) { showToast(error.message, "error"); }
  });
  noteTitle.addEventListener("keydown", (event) => {
    if (event.key === "Enter") event.preventDefault();
  });
  noteTitle.addEventListener("input", () => {
    const normalized = noteTitle.value.replace(/[\r\n]+/g, " ");
    if (normalized !== noteTitle.value) noteTitle.value = normalized;
    scheduleNoteTitleFit();
  });
  window.addEventListener("resize", scheduleNoteTitleFit);
  if (window.ResizeObserver) {
    noteTitleResizeObserver = new ResizeObserver(scheduleNoteTitleFit);
    noteTitleResizeObserver.observe(noteTitle.parentElement);
  }
  $("#delete-note-button").addEventListener("click", deleteCurrentNote);
  $("#export-md-button").addEventListener("click", () => { if (state.note) window.location.href = `/api/notes/${state.note.id}/export.md`; });
  $("#export-obsidian-button").addEventListener("click", exportToObsidian);
  knowledgeApiButton.addEventListener("click", runKnowledgeMaterials);
  knowledgeCodexButton.addEventListener("click", runKnowledgeSynthesis);
  knowledgeReadinessButton.addEventListener("click", () => {
    state.knowledgeDetailsOpen = !state.knowledgeDetailsOpen;
    renderKnowledgeWorkflow();
  });
  knowledgeTranscriptMode.addEventListener("change", () => {
    state.knowledgeTranscriptMode = ["original", "speaker"].includes(knowledgeTranscriptMode.value) ? knowledgeTranscriptMode.value : "polished";
    state.knowledgePreflightError = null;
    renderKnowledgeWorkflow();
  });
  refreshSubtitlesButton.addEventListener("click", refreshSubtitles);
  asrButton.addEventListener("click", runAsr);
  diarizationButton.addEventListener("click", runDiarization);
  playerFrame.addEventListener("load", () => {
    if (state.pendingSeekSeconds === null) return;
    const value = state.pendingSeekSeconds;
    state.pendingSeekSeconds = null;
    window.setTimeout(() => sendPlayerSeek(value), 80);
  });
  noteEngineSelect.addEventListener("change", async () => {
    renderAiControls();
    try { await patchNote({ processingEngine: noteEngineSelect.value }); updateAIButtons(); showToast(`默认 AI 引擎已切换为 ${noteEngineSelect.options[noteEngineSelect.selectedIndex].text}`, "success"); } catch (error) { showToast(error.message, "error"); }
  });
  noteProviderSelect.addEventListener("change", async () => {
    const provider = noteProviderSelect.value;
    noteModelSelect.value = "";
    noteProviderSelect.disabled = true;
    noteModelSelect.disabled = true;
    try {
      await patchNote({ processingProvider: provider, processingModel: "" });
      renderAiControls();
      showToast("API 平台已保存", "success");
    } catch (error) {
      renderAiControls();
      showToast(error.message, "error");
    }
  });
  noteModelSelect.addEventListener("change", async () => {
    const model = noteModelSelect.value;
    noteModelSelect.disabled = true;
    try {
      await patchNote({ processingModel: model });
      renderAiControls();
      showToast("模型已保存", "success");
    } catch (error) {
      renderAiControls();
      showToast(error.message, "error");
    }
  });
  noteTags.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-tag]");
    if (remove) toggleTag(remove.dataset.removeTag);
    if (event.target.closest("#add-tag-button")) addTag();
  });
  pageSelect.addEventListener("change", () => { state.pageIndex = Number(pageSelect.value); state.trackIndex = 0; state.speakerFilter = "all"; state.activeSegmentId = ""; state.pendingSeekSeconds = null; renderTrackOptions(); renderTranscript(); renderPlayer(0, { force: true }); renderAnalysisScope(); renderDiarizationButton(); });
  trackSelect.addEventListener("change", () => { state.trackIndex = Number(trackSelect.value); state.speakerFilter = "all"; state.activeSegmentId = ""; renderTranscript(); renderAnalysisScope(); renderDiarizationButton(); });
  analysisPageScopeSelect.addEventListener("change", () => { state.analysisPageScope = analysisPageScopeSelect.value === "all" ? "all" : "current"; renderAnalysisScope(); });
  analysisTrackScopeSelect.addEventListener("change", () => { state.analysisTrackScope = analysisTrackScopeSelect.value === "all" ? "all" : "current"; renderAnalysisScope(); });
  transcriptSearch.addEventListener("input", () => { state.transcriptSearch = transcriptSearch.value; renderTranscript(); });
  speakerFilter.addEventListener("change", () => { state.speakerFilter = speakerFilter.value || "all"; state.activeSegmentId = ""; renderTranscript(); });
  transcriptList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-seek]");
    if (!button) return;
    const row = button.closest("[data-segment-id]");
    state.activeSegmentId = row?.dataset.segmentId || "";
    transcriptList.querySelectorAll(".transcript-row.is-active").forEach((item) => item.classList.remove("is-active"));
    row?.classList.add("is-active");
    seekTo(Number(button.dataset.seek));
  });
  transcriptState.addEventListener("click", (event) => {
    if (event.target.closest("[data-start-asr]")) return runAsr();
    if (event.target.closest("[data-start-diarization]")) return runDiarization();
    const retry = event.target.closest("[data-retry-task]");
    if (retry) retryAnalysisTask(retry.dataset.retryTask);
  });
  speakerLabels.addEventListener("click", (event) => {
    const button = event.target.closest("[data-speaker-label]");
    if (button) renameSpeaker(button.dataset.speakerLabel);
  });
  $$(".transcript-tab").forEach((button) => button.addEventListener("click", () => {
    setTranscriptMode(button.dataset.transcriptMode);
  }));
  $$(".left-tab").forEach((button) => button.addEventListener("click", () => {
    state.leftTab = button.dataset.leftTab;
    $$(".left-tab").forEach((item) => item.classList.toggle("active", item === button));
    renderLeftPanel();
  }));
  leftContent.addEventListener("click", (event) => {
    const action = event.target.closest("[data-structure-action]");
    if (action) return runAnalysis(action.dataset.structureAction);
    const mindmapAction = event.target.closest("[data-mindmap-action]");
    if (mindmapAction) {
      handleMindmapAction(mindmapAction.dataset.mindmapAction, mindmapAction.closest("[data-mindmap-surface]"));
      return;
    }
    const node = event.target.closest("[data-structure-segments]");
    if (!node) return;
    const ids = JSON.parse(node.dataset.structureSegments || "[]");
    const result = findSegmentById(ids[0]);
    if (result) {
      state.activeSegmentId = result.segment.id;
      state.pageIndex = result.pageIndex;
      state.trackIndex = result.trackIndex;
      state.transcriptSearch = "";
      transcriptSearch.value = "";
      renderPageOptions();
      renderTrackOptions();
      renderTranscript();
      seekTo(result.segment.from);
    }
  });
  mindmapDialogContent.addEventListener("click", (event) => {
    const action = event.target.closest("[data-mindmap-action]");
    if (!action) return;
    handleMindmapAction(action.dataset.mindmapAction, action.closest("[data-mindmap-surface]"));
  });
  $("#structure-refresh").addEventListener("click", renderLeftPanel);
  $("#polish-button").addEventListener("click", () => runAnalysis("polish"));
  $("#outline-button").addEventListener("click", () => { state.leftTab = "outline"; $$(".left-tab").forEach((item) => item.classList.toggle("active", item.dataset.leftTab === "outline")); runAnalysis("outline"); });
  $("#mindmap-button").addEventListener("click", () => { state.leftTab = "mindmap"; $$(".left-tab").forEach((item) => item.classList.toggle("active", item.dataset.leftTab === "mindmap")); runAnalysis("mindmap"); });
  $("#structure-button").addEventListener("click", () => { state.leftTab = "mindmap"; $$(".left-tab").forEach((item) => item.classList.toggle("active", item.dataset.leftTab === "mindmap")); runAnalysis("structure"); });
  initRecordToolbar();
  window.addEventListener("beforeunload", () => { if (recordEditor.innerHTML && state.note && state.recordSaveTimer) saveRecord(); });
}

async function init() {
  bindEvents();
  setView("library");
  await loadNotes();
  const initialUrl = new URL(window.location.href);
  const noteId = initialUrl.searchParams.get("note");
  const seconds = Math.max(0, Number(initialUrl.searchParams.get("t") || 0));
  if (noteId) {
    await openNote(noteId);
    if (seconds > 0 && state.note) seekTo(seconds);
  }
}

init();
