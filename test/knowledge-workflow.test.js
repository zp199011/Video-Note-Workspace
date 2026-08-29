"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-note-knowledge-"));
process.env.VIDEO_NOTE_DATA_DIR = testDataDir;
const workspace = require("../server");

function makeNote(segmentCount = 70, noteId = "note_knowledgeflow") {
  const body = Array.from({ length: segmentCount }, (_, index) => ({
    id: `seg-${index}`, index, from: index * 2, to: index * 2 + 1.8, text: `原文第 ${index + 1} 段，包含可追溯的知识内容。`, content: `原文第 ${index + 1} 段，包含可追溯的知识内容。`
  }));
  const polishedSegments = body.map((segment) => ({
    id: segment.id, segmentId: segment.id, from: segment.from, to: segment.to, page: 1, pageIndex: 0,
    trackId: "track-zh", sourceKey: "p1::track-zh", text: `润色第 ${segment.index + 1} 段，完整保留信息。`
  }));
  return {
    schemaVersion: 1, id: noteId, title: "知识沉淀测试", tags: ["测试"], pinned: false, progress: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "ready",
    source: { bvid: "BVKNOWLEDGE", title: "知识沉淀测试", author: "测试者", url: "https://www.bilibili.com/video/BVKNOWLEDGE", pages: [{ page: 1, cid: 1, part: "P1" }] },
    transcript: {
      original: { status: "ready", pages: [{ page: 1, cid: 1, part: "P1", subtitles: [{ id: "track-zh", language: "zh", languageName: "中文", body }] }] },
      polished: { status: "ready", variants: { "p1::track-zh": { sourceKey: "p1::track-zh", segments: polishedSegments } }, segments: polishedSegments },
      speaker: { status: "not_generated", variants: {} }
    },
    outline: { status: "not_generated", tree: null }, mindmap: { status: "not_generated", tree: null },
    knowledge: { schemaVersion: 1, status: "not_started", material: null, audit: { status: "not_started", issues: [] }, synthesis: null },
    record: { html: "<p>我的批注</p>", plainText: "我的批注", revision: 1 }, speaker: { status: "not_started", labels: {} },
    processing: { subtitle: "ready", ai: "ready", asr: "not_started", diarization: "not_started" }, settings: { processingEngine: "api", provider: "test", model: "test-model" }
  };
}

function extractionResult(message) {
  const payload = JSON.parse(message);
  const first = payload.segments[0];
  return {
    text: JSON.stringify({
      coverage: { ...payload.coverage, omissionsChecked: true },
      items: [{ id: `${payload.coverage.chunkId}-item`, type: "opinion", title: "分块观点", statement: `来自 ${first.segmentId} 的可追溯观点`, explanation: "仅基于本块字幕", speakerId: "", speakerLabel: "", segmentIds: [first.segmentId], concepts: ["完整性"], needsExternalVerification: false }],
      concepts: [{ label: "完整性", definition: "资料分块要逐块完成", segmentIds: [first.segmentId] }], emptyReason: ""
    }),
    model: "api-test"
  };
}

function synthesisResult(firstId, secondId) {
  return {
    text: JSON.stringify({
      audit: { status: "PASS", summary: "分块、引用与快照一致", issues: [] },
      synthesis: {
        oneSentenceSummary: "完整资料通过核查后才能合成。", whyItMatters: "避免将残缺材料写成看似完整的笔记。",
        coreConclusions: [{ id: "c1", title: "完整性是前置条件", statement: "所有 API 分块必须完成。", type: "opinion", segmentIds: [firstId], needsExternalVerification: false }],
        outline: { title: "知识流程", summary: "先整理再核查", items: [{ id: "o1", title: "整理与核查", summary: "API 与 Codex 各司其职。", keyPoints: ["不得缺块"], segmentIds: [firstId], children: [] }] },
        mindmap: { id: "root", label: "可生长知识", summary: "完整性驱动合成", relation: "", keywords: ["完整"], segmentIds: [], children: [{ id: "m1", label: "完整性门禁", summary: "缺块则阻止", relation: "依赖", keywords: ["门禁"], segmentIds: [secondId], children: [] }] },
        cases: [], actions: [{ title: "先补齐失败分块", detail: "只重试失败块。", segmentIds: [secondId] }], controversies: [],
        knowledgeCards: [{ title: "知识合成完整性门禁", summary: "不完整的资料不允许进入全局合成。", concepts: ["完整性"], segmentIds: [firstId, secondId] }]
      }
    }), model: "codex-test"
  };
}

test("API 逐块完成后才解锁 Codex，并生成可溯源总 MD", async () => {
  const note = makeNote();
  workspace.saveNote(note);
  workspace.setAiCallOverrideForTests(async ({ operation, message }) => {
    if (operation === "knowledge_chunk") return extractionResult(message);
    const current = workspace.loadNote(note.id);
    const ids = current.knowledge.material.snapshot.segments.map((segment) => segment.segmentId);
    return synthesisResult(ids[0], ids.at(-1));
  });
  const { task } = workspace.createAnalysisTask(note, { operation: "knowledge_extract", transcriptMode: "polished", pageScope: "all", trackScope: "current", provider: "test", model: "api-test" });
  await workspace.runTask(task, (progress) => workspace.executeAnalysis(task, progress));
  const generationLog = workspace.listGenerationLogs(note.id).find((item) => item.taskId === task.id);
  assert.ok(generationLog, "API 资料整理任务应写入生成日志");
  assert.equal(generationLog.status, "completed");
  assert.ok(generationLog.events.some((event) => event.event === "submitted"));
  assert.ok(generationLog.events.some((event) => event.event === "started"));
  assert.ok(generationLog.events.some((event) => event.event === "progress" && event.progress > 5));
  assert.ok(generationLog.events.some((event) => event.event === "completed"));
  const materialReady = workspace.loadNote(note.id);
  assert.equal(materialReady.knowledge.status, "materials_ready");
  assert.equal(materialReady.knowledge.material.completeness.ready, true);
  assert.ok(materialReady.knowledge.material.completeness.expectedSegmentCount < 70, "AI 润色版应先合并成语义段落");
  assert.equal(materialReady.knowledge.material.completeness.expectedSourceSegmentCount, 70);
  assert.equal(materialReady.knowledge.material.completeness.processedSourceSegmentCount, 70);
  assert.ok(materialReady.knowledge.material.chunks.length >= 1);

  const synthesisTask = workspace.createKnowledgeSynthesisTask(materialReady, {});
  await workspace.runTask(synthesisTask, (progress) => workspace.executeAnalysis(synthesisTask, progress));
  const ready = workspace.loadNote(note.id);
  assert.equal(ready.knowledge.status, "ready");
  assert.equal(ready.knowledge.audit.status, "PASS");
  const markdown = workspace.buildMarkdown(ready);
  assert.match(markdown, /status: "ready"/);
  assert.match(markdown, /## 核心结论/);
  assert.match(markdown, /\[\[知识合成完整性门禁\]\]/);
  assert.match(markdown, /```mermaid/);
  assert.match(markdown, /t=0/);
  const vaultPath = path.join(testDataDir, "test-vault");
  fs.mkdirSync(vaultPath, { recursive: true });
  fs.writeFileSync(path.join(testDataDir, "settings.json"), JSON.stringify({ obsidianVaultPath: vaultPath, obsidianFolder: "inbox/video-notes" }), "utf8");
  const obsidianPreview = workspace.previewCodexFileTask(ready, "sync_obsidian");
  assert.equal(obsidianPreview.fullContent, markdown);
  assert.equal(obsidianPreview.contentHash.length, 64);
});

test("任一 API 分块失败时，后端拒绝创建 Codex 合成任务", async () => {
  const note = makeNote(240, "note_knowledgeblocked");
  workspace.saveNote(note);
  workspace.setAiCallOverrideForTests(async ({ operation, message }) => {
    if (operation === "knowledge_chunk" && JSON.parse(message).coverage.chunkId.includes("-001-")) throw Object.assign(new Error("模拟首个分块失败"), { code: "SIMULATED_TIMEOUT" });
    return extractionResult(message);
  });
  const { task } = workspace.createAnalysisTask(note, { operation: "knowledge_extract", transcriptMode: "polished", pageScope: "all", trackScope: "current", provider: "test" });
  const result = await workspace.runTask(task, (progress) => workspace.executeAnalysis(task, progress));
  assert.equal(result.status, "failed");
  const partial = workspace.loadNote(note.id);
  assert.equal(partial.knowledge.material.completeness.ready, false);
  assert.equal(partial.knowledge.material.completeness.failedChunkCount, 1);
  assert.throws(() => workspace.createKnowledgeSynthesisTask(partial, {}), (error) => error.code === "KNOWLEDGE_MATERIAL_INCOMPLETE");
});

test("Codex 审计 BLOCKED 时不保存合成结果，也不伪装成正式 MD", () => {
  const note = makeNote(4, "note_codexblocked");
  const input = workspace.buildKnowledgeInput(note, { transcriptMode: "polished", pageScope: "all", trackScope: "current" });
  const chunks = workspace.createKnowledgeChunks(input.segments).map((chunk) => ({ ...chunk, status: "completed", output: normalizeChunkForTest(chunk) }));
  const material = { status: "ready", materialHash: "hash", snapshot: { ...input.snapshotCore, snapshotHash: input.snapshotHash }, chunks };
  const result = workspace.normalizeCodexSynthesis({ audit: { status: "BLOCKED", summary: "证据冲突", issues: [{ code: "CONFLICT", message: "两条资料互相冲突", chunkIds: [chunks[0].id], segmentIds: [input.segments[0].segmentId] }] }, synthesis: { oneSentenceSummary: "不应保存" } }, material);
  assert.equal(result.audit.status, "BLOCKED");
  assert.equal(result.synthesis, null);
  note.knowledge = { status: "blocked", material: { ...material, completeness: { ready: true } }, audit: result.audit, synthesis: null };
  assert.match(workspace.buildMarkdown(note), /status: "draft"/);
  assert.doesNotMatch(workspace.buildMarkdown(note), /不应保存/);
});

test("知识整理对一小时说话人版硬限制为 1-5 次 API，不重复发送源字幕 ID", () => {
  const segments = Array.from({ length: 185 }, (_, index) => ({
    segmentId: `speaker-paragraph-${index + 1}`,
    from: index * 20,
    to: index * 20 + 19,
    page: 1,
    track: "中文",
    trackId: "track-zh",
    sourceKey: "p1::track-zh",
    text: `这是第 ${index + 1} 个说话人段落，包含需要完整整理的观点、例子、条件和结论。`.repeat(2),
    speakerId: index % 2 ? "speaker_02" : "speaker_01",
    speakerLabel: index % 2 ? "嘉宾" : "主持人",
    sourceSegmentIds: Array.from({ length: 7 }, (_, childIndex) => `raw-${index * 7 + childIndex + 1}`)
  }));
  const chunks = workspace.createKnowledgeChunks(segments);
  assert.ok(chunks.length >= 1 && chunks.length <= 5);
  assert.deepEqual(chunks.flatMap((chunk) => chunk.segmentIds), segments.map((segment) => segment.segmentId));
  assert.deepEqual(chunks.flatMap((chunk) => chunk.segments).flatMap((segment) => segment.sourceSegmentIds), segments.flatMap((segment) => segment.sourceSegmentIds));
  assert.ok(chunks.every((chunk) => chunk.payloadChars < 12000));
});

test("服务重启后知识流程退回可重试状态，不永久卡在整理中", () => {
  const partial = makeNote(4, "note_knowledgeinterrupted");
  partial.knowledge = {
    status: "extracting",
    material: { status: "partial", completeness: { ready: false } },
    audit: { status: "not_started", issues: [] }
  };
  assert.equal(workspace.restoreInterruptedKnowledgeState(partial), true);
  assert.equal(partial.knowledge.status, "materials_partial");

  const reviewing = makeNote(4, "note_knowledgereviewing");
  reviewing.knowledge = {
    status: "reviewing",
    material: { status: "ready", completeness: { ready: true } },
    audit: { status: "running", issues: [{ code: "OLD" }] }
  };
  assert.equal(workspace.restoreInterruptedKnowledgeState(reviewing), true);
  assert.equal(reviewing.knowledge.status, "materials_ready");
  assert.equal(reviewing.knowledge.audit.status, "not_started");
  assert.deepEqual(reviewing.knowledge.audit.issues, []);
});

function normalizeChunkForTest(chunk) {
  return { coverage: { chunkId: chunk.id, firstSegmentId: chunk.firstSegmentId, lastSegmentId: chunk.lastSegmentId, segmentCount: chunk.segmentCount, omissionsChecked: true }, items: [], concepts: [], emptyReason: "测试分块无需额外提取" };
}

test.after(() => workspace.setAiCallOverrideForTests(null));
