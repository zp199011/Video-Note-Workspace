"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-note-stage2c-"));
process.env.VIDEO_NOTE_DATA_DIR = testDataDir;
const workspace = require("../server");

function makeNote(id = "note_speakercontract") {
  const originalSegments = [
    { id: "seg-1", from: 0, to: 2, text: "第一句话。" },
    { id: "seg-2", from: 2.1, to: 4, text: "第二句话。" },
    { id: "seg-3", from: 4.2, to: 6, text: "第三句话。" },
    { id: "seg-4", from: 6.1, to: 8, text: "两人同时说。" },
    { id: "seg-5", from: 8.1, to: 10, text: "低置信度。" }
  ];
  return {
    schemaVersion: 1,
    id,
    title: "说话人版数据契约测试",
    tags: [], pinned: false, progress: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "ready",
    source: { bvid: "BVSPEAKER", title: "说话人测试", author: "测试", duration: 10, url: "https://www.bilibili.com/video/BVSPEAKER", pages: [{ page: 1, cid: 1, part: "P1", duration: 10 }] },
    transcript: {
      original: { source: "bilibili", status: "ready", pages: [{ page: 1, cid: 1, part: "P1", duration: 10, subtitles: [{ id: "track-zh", label: "公开字幕", languageName: "中文", segments: originalSegments }] }] },
      polished: { status: "ready", variants: { "p1::track-zh": { segments: originalSegments.map((segment) => ({ segmentId: segment.id, from: segment.from, to: segment.to, text: `润色-${segment.text}` })) } }, segments: [] },
      speaker: { status: "not_generated", variants: {} }
    },
    outline: { status: "not_generated", tree: null }, mindmap: { status: "not_generated", tree: null },
    record: { html: "", plainText: "", revision: 0 },
    speaker: { status: "not_started", segments: [], labels: {} },
    processing: { subtitle: "ready", ai: "ready", asr: "not_started", diarization: "not_started" },
    settings: { processingEngine: "none", provider: "", model: "" }
  };
}

const speakerIntervals = [
  { speakerId: "speaker_01", from: 0, to: 4, confidence: 0.95 },
  { speakerId: "speaker_02", from: 4, to: 6, confidence: 0.9 },
  { speakerId: "speaker_01", from: 6, to: 8, confidence: 0.9 },
  { speakerId: "speaker_02", from: 6, to: 8, confidence: 0.9 },
  { speakerId: "speaker_02", from: 8, to: 10, confidence: 0.2 }
];

test("说话人版优先使用完整润色文字，并按说话人确定性合并", () => {
  const note = makeNote();
  const built = workspace.buildSpeakerTranscript(note, 0, 0, speakerIntervals, { gapSeconds: 1.5, maxSegmentSeconds: 20, minOverlapRatio: 0.35, lowConfidence: 0.55, ambiguityRatio: 0.6 });
  assert.equal(built.source, "polished");
  assert.equal(built.segments.length, 4);
  assert.equal(built.segments[0].speakerId, "speaker_01");
  assert.equal(built.segments[0].from, 0);
  assert.equal(built.segments[0].to, 4);
  assert.deepEqual(built.segments[0].sourceSegmentIds, ["seg-1", "seg-2"]);
  assert.equal(built.segments[0].text, "润色-第一句话。 润色-第二句话。");
  assert.equal(built.segments[2].speakerId, "speaker_multiple");
  assert.equal(built.segments[3].speakerId, "speaker_unknown");
});

test("AI 润色阅读版合并为语义段落，同时保留全部源字幕 ID", () => {
  const note = makeNote("note_polishedparagraphs");
  const input = workspace.buildKnowledgeInput(note, { transcriptMode: "polished", pageScope: "all", trackScope: "current" });
  assert.ok(input.segments.length < 5);
  assert.equal(input.sourceSegmentCount, 5);
  assert.deepEqual(input.segments.flatMap((segment) => segment.sourceSegmentIds), ["seg-1", "seg-2", "seg-3", "seg-4", "seg-5"]);
  assert.ok(input.segments[0].text.includes("润色-第一句话。"));
  assert.ok(input.segments[0].text.includes("润色-第二句话。"));
  const preview = workspace.previewKnowledgeMaterials(note, { transcriptMode: "polished", pageScope: "all", trackScope: "current" });
  assert.equal(preview.sourceSegmentCount, 5);
  assert.equal(preview.knowledgeSegmentCount, input.segments.length);
  assert.ok(preview.chunkCount >= 1);
  assert.ok(preview.inputTokens > 1);
});

test("知识整理可直接使用合并说话人版，未确定片段不会阻断", () => {
  const note = makeNote("note_speakerknowledge");
  const built = workspace.buildSpeakerTranscript(note, 0, 0, speakerIntervals, { gapSeconds: 1.5, maxSegmentSeconds: 20, minOverlapRatio: 0.35, lowConfidence: 0.55, ambiguityRatio: 0.6 });
  note.transcript.speaker = { status: "ready", variants: { "p1::track-zh": { ...built, sourceKey: "p1::track-zh" } } };
  note.speaker.labels = { speaker_01: "主持人", speaker_02: "嘉宾", speaker_unknown: "未确定", speaker_multiple: "多人" };
  const input = workspace.buildKnowledgeInput(note, { transcriptMode: "speaker", pageScope: "all", trackScope: "current" });
  assert.equal(input.transcriptMode, "speaker");
  assert.equal(input.segments.length, 4);
  assert.equal(input.sourceSegmentCount, 5);
  assert.equal(input.segments.at(-1).speakerId, "speaker_unknown");
  assert.equal(input.segments.at(-1).speakerLabel, "未确定");
  assert.deepEqual(input.segments.flatMap((segment) => segment.sourceSegmentIds), ["seg-1", "seg-2", "seg-3", "seg-4", "seg-5"]);
});

test("说话人是否确定不设门槛，但漏掉源字幕会被后端拦截", () => {
  const note = makeNote("note_speakercoverage");
  const built = workspace.buildSpeakerTranscript(note, 0, 0, speakerIntervals);
  built.segments.at(-1).sourceSegmentIds = [];
  note.transcript.speaker = { status: "ready", variants: { "p1::track-zh": { ...built, sourceKey: "p1::track-zh" } } };
  assert.throws(
    () => workspace.buildKnowledgeInput(note, { transcriptMode: "speaker", pageScope: "all", trackScope: "current" }),
    (error) => error.code === "KNOWLEDGE_SOURCE_COVERAGE_INCOMPLETE"
  );
});

test("模型未提供置信度时按时间重叠判断，不把 null 当作零分", () => {
  const note = makeNote("note_speakernullconfidence");
  const intervals = [{ speakerId: "speaker_01", from: 0, to: 10, confidence: null }];
  const built = workspace.buildSpeakerTranscript(note, 0, 0, intervals, { gapSeconds: 1.5, maxSegmentSeconds: 20 });
  assert.equal(built.segments.length, 1);
  assert.equal(built.segments[0].speakerId, "speaker_01");
  assert.deepEqual(built.segments[0].sourceSegmentIds, ["seg-1", "seg-2", "seg-3", "seg-4", "seg-5"]);
});

test("同一说话人也受最大段长约束，不会合并成超长整段", () => {
  const note = makeNote("note_speakermaxlength");
  const intervals = [{ speakerId: "speaker_01", from: 0, to: 10, confidence: 0.9 }];
  const built = workspace.buildSpeakerTranscript(note, 0, 0, intervals, { gapSeconds: 1.5, maxSegmentSeconds: 5 });
  assert.ok(built.segments.length > 1);
  assert.ok(built.segments.every((segment) => segment.to - segment.from <= 5));
});

test("润色版不完整时整条轨道回退原文，不混搭或调用 LLM", () => {
  const note = makeNote("note_speakerfallback");
  note.transcript.polished.variants["p1::track-zh"].segments.pop();
  const built = workspace.buildSpeakerTranscript(note, 0, 0, speakerIntervals);
  assert.equal(built.source, "original");
  assert.ok(built.segments.every((segment) => !segment.text.includes("润色-")));
});

test("保存说话人版时保留原文和润色版，并保存可追溯源 ID", () => {
  const note = makeNote("note_speakersave");
  workspace.saveNote(note);
  const { task } = workspace.createDiarizationTask(note, { pageIndex: 0, trackIndex: 0 });
  const originalSnapshot = JSON.stringify(note.transcript.original);
  const polishedSnapshot = JSON.stringify(note.transcript.polished);
  const saved = workspace.saveDiarizationResult(note, task, { ok: true, speakerModel: "cam++", speakerCount: 2, speakerSegments: speakerIntervals });
  assert.equal(JSON.stringify(saved.transcript.original), originalSnapshot);
  assert.equal(JSON.stringify(saved.transcript.polished), polishedSnapshot);
  assert.equal(saved.processing.diarization, "ready");
  assert.equal(saved.speaker.variants["p1::track-zh"].segments.length, speakerIntervals.length);
  assert.equal(saved.transcript.speaker.variants["p1::track-zh"].source, "polished");
  assert.ok(saved.transcript.speaker.variants["p1::track-zh"].segments.every((segment) => segment.id && segment.sourceSegmentIds.length));
  assert.equal(saved.speaker.labels.speaker_unknown, "未确定");
  assert.equal(saved.speaker.labels.speaker_multiple, "多人");
});

test("说话人任务失败会记录阶段，且不覆盖三个文字版本", async () => {
  const note = makeNote("note_speakerfailure");
  workspace.saveNote(note);
  const { task } = workspace.createDiarizationTask(note, { pageIndex: 0, trackIndex: 0 });
  const transcriptSnapshot = JSON.stringify(note.transcript);
  const failed = await workspace.runTask(task, async () => {
    task.meta.stage = "speaker_embedding";
    const error = new Error("模拟 CAM++ 失败");
    error.code = "DIARIZATION_FAILED";
    throw error;
  });
  assert.equal(failed.status, "failed");
  const preserved = workspace.loadNote(note.id);
  assert.equal(JSON.stringify(preserved.transcript), transcriptSnapshot);
  assert.equal(preserved.processing.diarization, "failed");
  assert.equal(preserved.speaker.failedStage, "speaker_embedding");
});

test.after(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
});
