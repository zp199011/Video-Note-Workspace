"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-note-stage2a-"));
process.env.VIDEO_NOTE_DATA_DIR = testDataDir;
const workspace = require("../server");

function makeSegments(count = 180) {
  return Array.from({ length: count }, (_, index) => ({
    id: `seg-${index}`,
    segmentId: `seg-${index}`,
    from: index * 1.5,
    to: index * 1.5 + 1.4,
    page: index < Math.ceil(count / 2) ? 1 : 2,
    pageIndex: index < Math.ceil(count / 2) ? 0 : 1,
    trackId: index < Math.ceil(count / 2) ? "track-a" : "track-b",
    track: index < Math.ceil(count / 2) ? "中文" : "English",
    sourceKey: index < Math.ceil(count / 2) ? "p1::track-a" : "p2::track-b",
    text: `第 ${index} 条完整字幕。${"内容".repeat(24)}`
  }));
}

test("长字幕按完整 segment 分块并保留全部对齐元数据", () => {
  const segments = makeSegments(205);
  const first = workspace.createAnalysisChunks(segments);
  const second = workspace.createAnalysisChunks(segments);
  assert.ok(first.length > 2);
  assert.deepEqual(first.map((chunk) => chunk.id), second.map((chunk) => chunk.id));
  const flattened = first.flatMap((chunk) => chunk.segments);
  assert.equal(flattened.length, segments.length);
  assert.deepEqual(flattened.map((segment) => segment.segmentId), segments.map((segment) => segment.id));
  assert.ok(first.every((chunk) => chunk.inputChars <= workspace.AI_CHUNK_TEXT_MAX_CHARS));
  assert.ok(first.every((chunk) => chunk.segments.every((segment) => segment.sourceKey && segment.segmentId && Number.isFinite(segment.from) && Number.isFinite(segment.to) && segment.page && segment.trackId)));
  assert.ok(first.every((chunk) => new Set(chunk.segments.map((segment) => segment.sourceKey)).size === 1));
});

test("翻译入口已移除，新请求和旧任务重试都会明确拒绝", () => {
  assert.throws(
    () => workspace.analysisRequestFromBody(null, { operation: "translate" }),
    (error) => error.code === "TRANSLATION_REMOVED" && error.statusCode === 410
  );
  assert.throws(
    () => workspace.prepareAnalysisTaskRetry({ id: "task-old-translate", type: "analysis", status: "interrupted", meta: { operation: "translate" } }),
    (error) => error.code === "TRANSLATION_REMOVED" && error.statusCode === 410
  );
});

test("润色按内容量自动规划一到五次调用，不再逐条复写时间轴元数据", () => {
  const segments = Array.from({ length: 1296 }, (_, index) => ({
    id: `seg-${index}`,
    from: index * 2,
    to: index * 2 + 1.8,
    page: 1,
    pageIndex: 0,
    trackId: "track-a",
    track: "中文",
    sourceKey: "p1::track-a",
    text: `这是第${index + 1}条需要润色的口语字幕`
  }));
  const chunks = workspace.createAnalysisChunks(segments, "polish");
  assert.ok(chunks.length >= 1 && chunks.length <= 5);
  assert.equal(chunks.flatMap((chunk) => chunk.segments).length, 1296);
  assert.ok(chunks.reduce((sum, chunk) => sum + chunk.blockCount, 0) > 40);
  assert.ok(chunks.every((chunk) => chunk.transcript.split(chunk.delimiter).length === chunk.blockCount));
  assert.deepEqual(chunks.flatMap((chunk) => chunk.blocks).flatMap((block) => block.sourceSegmentIds), segments.map((segment) => segment.id));
});

test("AI 结果必须逐段完整对齐，缺段与假 ID 会被拒绝", () => {
  const input = makeSegments(6);
  const reversed = [...input].reverse().map((segment) => ({ segmentId: segment.id, text: `处理-${segment.text}` }));
  const normalized = workspace.normalizeAlignedSegments({ segments: reversed }, input);
  assert.deepEqual(normalized.map((segment) => segment.segmentId), input.map((segment) => segment.id));
  assert.ok(normalized.every((segment) => segment.text.startsWith("处理-")));
  assert.throws(
    () => workspace.normalizeAlignedSegments({ segments: reversed.slice(1) }, input),
    (error) => error.code === "AI_MISSING_SEGMENTS"
  );
  assert.throws(
    () => workspace.normalizeAlignedSegments({ segments: [{ segmentId: "made-up", text: "错误" }] }, input),
    (error) => error.code === "AI_INVALID_SEGMENT_ID"
  );
});

test("结构结果去重、限制节点并过滤不存在的 segmentId", () => {
  const input = makeSegments(30);
  const items = Array.from({ length: 20 }, (_, index) => ({
    title: index < 2 ? "重复章节" : `章节 ${index}`,
    summary: "摘要",
    segmentIds: [input[index % input.length].id, "unknown-id"],
    children: []
  }));
  const outline = workspace.sanitizeOutlineTree({ title: "主题", items }, input);
  assert.ok(outline.items.length <= 12);
  assert.equal(outline.items.filter((item) => item.title === "重复章节").length, 1);
  assert.ok(outline.items.every((item) => item.segmentIds.every((id) => id !== "unknown-id")));

  const mindmap = workspace.sanitizeMindmapTree({
    label: "中心",
    children: Array.from({ length: 16 }, (_, index) => ({ label: `概念 ${index}`, segmentIds: [input[index].id, "unknown-id"], children: [] }))
  }, input);
  assert.ok(mindmap.children.length <= 10);
  assert.ok(mindmap.children.every((item) => item.segmentIds.every((id) => id !== "unknown-id")));
});

test("思维导图全局合并只接收分块摘要，不重新接收完整原文", () => {
  const inputSegments = makeSegments(90).map((segment) => ({ ...segment, text: `${segment.text} RAW_SECRET_MARKER` }));
  const chunks = workspace.createAnalysisChunks(inputSegments);
  const chunkResults = chunks.map((chunk) => ({
    chunk,
    output: {
      concepts: [{ id: `concept-${chunk.index}`, label: `概念 ${chunk.index}`, summary: "摘要", relation: "包含", keywords: ["关键词"], segmentIds: [chunk.segments[0].segmentId] }]
    }
  }));
  const message = workspace.buildGlobalStructureMessage("mindmap", { segments: inputSegments, scope: { pageScope: "all", trackScope: "all" } }, chunkResults, { title: "测试", source: { bvid: "BVTEST" } });
  assert.ok(message.length <= workspace.AI_CHUNK_MAX_CHARS);
  assert.equal(message.includes("RAW_SECRET_MARKER"), false);
  assert.ok(message.includes("concepts"));
});

test("大纲和导图的完成分块可直接进入全局合并", async () => {
  const segments = makeSegments(8).map((segment) => ({ ...segment, page: 1, pageIndex: 0, trackId: "track-a", track: "中文", sourceKey: "p1::track-a" }));
  const track = {
    id: "track-a",
    language: "zh-CN",
    languageName: "中文",
    label: "公开字幕",
    isAI: false,
    segments: segments.map((segment) => ({ id: segment.id, from: segment.from, to: segment.to, text: segment.text }))
  };
  const note = {
    schemaVersion: 1,
    id: "note_structuremerge",
    title: "结构合并测试",
    tags: [], pinned: false, progress: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "ready",
    source: { bvid: "BVSTRUCTURE", title: "结构合并测试", author: "测试", duration: 30, url: "https://www.bilibili.com/video/BVSTRUCTURE", pages: [{ page: 1, cid: 1, part: "P1", duration: 30 }] },
    transcript: {
      original: { source: "bilibili", status: "ready", pages: [{ page: 1, cid: 1, part: "P1", duration: 30, subtitles: [track] }] },
      polished: {
        status: "ready",
        variants: { "p1::track-a": { segments: segments.map((segment) => ({ id: segment.id, segmentId: segment.id, from: segment.from, to: segment.to, text: `润色：${segment.text}。` })) } },
        segments: []
      },
    },
    outline: { status: "not_generated", tree: null },
    mindmap: { status: "not_generated", tree: null },
    record: { html: "", plainText: "", revision: 0 },
    speaker: { status: "not_started", segments: [], labels: {} },
    processing: { subtitle: "ready", ai: "not_started", asr: "not_started", diarization: "not_started" },
    settings: { processingEngine: "codex", provider: "codex", model: "gpt-5.6-sol" }
  };
  workspace.saveNote(note);
  const calls = [];
  workspace.setAiCallOverrideForTests(async ({ operation }) => {
    calls.push(operation);
    if (operation === "outline_chunk") return { model: "gpt-5.6-sol", text: JSON.stringify({ chapters: [{ id: "chapter-1", title: "第一章", summary: "章节摘要", keyPoints: ["要点"], segmentIds: ["seg-0"], children: [] }] }) };
    if (operation === "mindmap_chunk") return { model: "gpt-5.6-sol", text: JSON.stringify({ concepts: [{ id: "concept-1", label: "核心概念", summary: "概念摘要", relation: "包含", keywords: ["关键词"], segmentIds: ["seg-0"], children: [] }] }) };
    if (operation === "outline_merge") return { model: "gpt-5.6-sol", text: JSON.stringify({ title: "完整大纲", summary: "全局摘要", items: [{ id: "outline-1", title: "第一章", summary: "章节摘要", keyPoints: ["要点"], segmentIds: ["seg-0"], children: [] }] }) };
    if (operation === "mindmap_merge") return { model: "gpt-5.6-sol", text: JSON.stringify({ id: "root", label: "完整导图", summary: "全局摘要", relation: "", keywords: ["关键词"], segmentIds: [], children: [{ id: "branch-1", label: "核心概念", summary: "概念摘要", relation: "包含", keywords: ["关键词"], segmentIds: ["seg-0"], children: [] }] }) };
    throw new Error(`未预期的操作：${operation}`);
  });
  try {
    const { task } = workspace.createAnalysisTask(note, {
      operation: "structure", engine: "codex", provider: "codex", model: "gpt-5.6-sol",
      pageIndex: 0, trackIndex: 0, pageScope: "current", trackScope: "current"
    });
    const completed = await workspace.runTask(task, (progress) => workspace.executeAnalysis(task, progress));
    assert.equal(completed.status, "completed");
    assert.deepEqual(calls.sort(), ["mindmap_chunk", "mindmap_merge", "outline_chunk", "outline_merge"].sort());
    const saved = workspace.loadNote(note.id);
    assert.equal(saved.outline.status, "ready");
    assert.equal(saved.mindmap.status, "ready");
    assert.equal(saved.processing.ai, "ready");
  } finally {
    workspace.setAiCallOverrideForTests(null);
  }
});

test("统一操作日志会脱敏且可以按笔记和时间查询", () => {
  workspace.appendOperationEvent("note_a", "subtitle_refreshed", {
    sessdata: "secret-cookie-value",
    apiKey: "secret-api-key",
    message: "SESSDATA=another-secret",
    authUsed: true
  });
  workspace.appendOperationEvent("note_b", "note_opened", { status: "ready" });
  const noteLogs = workspace.listOperationLogs({ noteId: "note_a" });
  assert.equal(noteLogs.length, 1);
  const serialized = JSON.stringify(noteLogs);
  assert.equal(serialized.includes("secret-cookie-value"), false);
  assert.equal(serialized.includes("secret-api-key"), false);
  assert.equal(serialized.includes("another-secret"), false);
  assert.equal(noteLogs[0].details.authUsed, true);
});

test("润色质量门禁拒绝无标点照抄，并接受有标点和真实段落的结果", () => {
  const input = makeSegments(12).map((segment) => ({ ...segment, text: `这是第${segment.segmentId}条没有标点的口语字幕内容` }));
  const copied = { segments: input.map((segment, index) => ({
    segmentId: segment.segmentId,
    text: segment.text,
    paragraphBreak: index === input.length - 1
  })) };
  assert.throws(
    () => workspace.normalizeAlignedSegments(copied, input, "polish"),
    (error) => error.code === "AI_POLISH_QUALITY_FAILED"
  );

  const polished = { segments: input.map((segment, index) => ({
    segmentId: segment.segmentId,
    text: `这是第 ${index + 1} 条经过润色的口语字幕内容${index % 3 === 2 ? "。" : "，"}`,
    paragraphBreak: index === input.length - 1 || index % 6 === 5
  })) };
  const normalized = workspace.normalizeAlignedSegments(polished, input, "polish");
  const quality = workspace.assessPolishQuality(input, normalized);
  assert.equal(quality.passed, true);
  assert.ok(quality.punctuationCount >= input.length);
  assert.ok(quality.paragraphBreakCount >= 1);

  const compact = workspace.normalizeAlignedSegments({ segments: input.map((segment, index) => ({
    i: index,
    t: `紧凑格式第 ${index + 1} 条，${index % 3 === 2 ? "表达完成。" : "继续说明，"}`,
    b: index === input.length - 1 || index % 6 === 5
  })) }, input, "polish");
  assert.equal(compact.length, input.length);
  assert.equal(compact.at(-1).paragraphBreak, true);
});

test("一次调用的段落结果必须连续覆盖全部原字幕", () => {
  const input = makeSegments(12).map((segment) => ({ ...segment, text: `第${segment.segmentId}条原始口语内容` }));
  const valid = workspace.normalizePolishParagraphs({ paragraphs: [
    { s: 0, e: 5, t: "这是第一段经过整理的完整内容，保留前六条原始口语中的观点、事实、例子和论证过程。它使用自然标点，完整说明上下文，也保留必要的表达细节。" },
    { s: 6, e: 11, t: "这是第二段经过整理的完整内容，继续保留后六条原始口语中的后续观点、转折、例子和必要细节。它没有压缩成摘要，最后形成可直接阅读的真实语义段落。" }
  ] }, input);
  assert.equal(valid.length, 2);
  assert.deepEqual(valid.flatMap((paragraph) => paragraph.sourceSegmentIds), input.map((segment) => segment.id));
  assert.equal(valid[0].sourceStartIndex, 0);
  assert.equal(valid[1].sourceEndIndex, 11);
  assert.throws(
    () => workspace.normalizePolishParagraphs({ paragraphs: [{ s: 0, e: 4, t: "只覆盖了一部分内容。" }, { s: 6, e: 11, t: "中间漏掉了一条字幕。" }] }, input),
    (error) => error.code === "AI_INVALID_POLISH_COVERAGE"
  );
  const broadInput = makeSegments(80).map((segment) => ({ ...segment, sourceKey: "p1::track-a", text: "这是一条需要完整保留的原始口语字幕内容" }));
  assert.throws(
    () => workspace.normalizePolishParagraphs({ paragraphs: [{ s: 0, e: 79, t: "模型把八十条字幕概括成了一个很短的章节摘要。" }] }, broadInput),
    (error) => error.code === "AI_POLISH_PARAGRAPH_TOO_BROAD"
  );
});

test("流式 AI 接口会跨网络分片拼回唯一完整正文", async () => {
  const encoder = new TextEncoder();
  const pieces = [
    'data: {"type":"meta","conversation":{"id":"conv-test"}}\n\n',
    'data: {"type":"delta","delta":"{\\"paragraphs\\":["}\n\n',
    'data: {"type":"delta","delta":"{\\"s\\":0,\\"e\\":1,\\"t\\":\\"完整段落。\\"}]}"}\n\n',
    'data: {"type":"done","conversation":{"messages":[]}}\n\n'
  ];
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces) {
        const bytes = encoder.encode(piece);
        controller.enqueue(bytes.slice(0, Math.max(1, Math.floor(bytes.length / 2))));
        controller.enqueue(bytes.slice(Math.max(1, Math.floor(bytes.length / 2))));
      }
      controller.close();
    }
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  const result = await workspace.readCanvasLlmStream(response, { operation: "polish", model: "test-model" });
  assert.deepEqual(JSON.parse(result.text), { paragraphs: [{ s: 0, e: 1, t: "完整段落。" }] });
  assert.equal(result.model, "test-model");
});

test("逐块润色必须等量返回并逐块保留原文信息量", () => {
  const input = makeSegments(24).map((segment) => ({ ...segment, sourceKey: "p1::track-a", text: `第${segment.segmentId}条口语内容需要补全标点并忠实保留` }));
  const chunk = workspace.createAnalysisChunks(input, "polish")[0];
  const output = chunk.blocks.map((block, index) => `这是第 ${index + 1} 个润色段落，${block.segments.map((segment) => `${segment.text}。`).join("")}`).join(chunk.delimiter);
  const normalized = workspace.normalizePolishBlockText(output, chunk);
  assert.equal(normalized.length, chunk.blockCount);
  assert.deepEqual(normalized.flatMap((paragraph) => paragraph.sourceSegmentIds), input.map((segment) => segment.id));
  assert.ok(normalized.every((paragraph) => paragraph.text.endsWith("。")));
  assert.throws(
    () => workspace.normalizePolishBlockText(chunk.blocks.slice(0, -1).map((block) => `${block.text}。`).join(chunk.delimiter), chunk),
    (error) => ["AI_POLISH_BLOCK_COUNT_MISMATCH", "AI_POLISH_QUALITY_FAILED"].includes(error.code)
  );
  const mergedParts = chunk.blocks.map((block, index) => `这是第 ${index + 1} 个润色段落，${block.segments.map((segment) => `${segment.text}。`).join("")}`);
  mergedParts[mergedParts.length - 2] += mergedParts.pop();
  const recovered = workspace.normalizePolishBlockText(mergedParts.join(chunk.delimiter), chunk);
  assert.equal(recovered.length, chunk.blockCount);
  assert.ok(recovered.every((paragraph) => paragraph.recoveredMergedBoundary === true));
  assert.deepEqual(recovered.flatMap((paragraph) => paragraph.sourceSegmentIds), input.map((segment) => segment.id));
  const compressed = chunk.blocks.map((block, index) => index === 0 ? "一句摘要。" : `${block.text}。`).join(chunk.delimiter);
  assert.throws(
    () => workspace.normalizePolishBlockText(compressed, chunk),
    (error) => error.code === "AI_POLISH_BLOCK_OVERCOMPRESSED"
  );
});

test("短视频润色使用较大的阅读段落，不再机械切成过多小块", () => {
  const input = makeSegments(199).map((segment) => ({ ...segment, sourceKey: "p1::track-a", text: "这是一句需要润色的短口语" }));
  const blocks = workspace.createPolishBlocks(input);
  assert.ok(blocks.length <= Math.ceil(input.reduce((sum, segment) => sum + segment.text.length, 0) / 300));
  assert.deepEqual(blocks.flatMap((block) => block.sourceSegmentIds), input.map((segment) => segment.id));
});

test("Codex 失败时优先显示末尾致命错误，不被启动警告遮住", () => {
  const stderr = [
    "ERROR codex_models_manager::cache: failed to load models cache",
    "WARN codex_core_plugins::manifest: ignoring plugin prompt",
    "ERROR: The 'gpt-5.6-sol' model requires a newer version of Codex."
  ].join("\n");
  const summary = workspace.summarizeCodexFailure(stderr, "");
  assert.match(summary, /requires a newer version of Codex/);
  assert.doesNotMatch(summary, /ignoring plugin prompt/);
});

test("CODEX_BIN 显式配置仍然拥有最高优先级", () => {
  const original = process.env.CODEX_BIN;
  process.env.CODEX_BIN = "/tmp/custom-codex";
  try {
    assert.equal(workspace.codexCliExecutable(), "/tmp/custom-codex");
  } finally {
    if (original === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = original;
  }
});

test.after(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
});
