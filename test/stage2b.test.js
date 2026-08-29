"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-note-stage2b-"));
process.env.VIDEO_NOTE_DATA_DIR = testDataDir;
const workspace = require("../server");

function makeNote(id = "note_asrcontract") {
  return {
    schemaVersion: 1,
    id,
    title: "ASR 数据契约测试",
    tags: [],
    pinned: false,
    progress: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "ready",
    source: {
      bvid: "BVASRTEST",
      title: "ASR 数据契约测试",
      author: "测试",
      duration: 20,
      url: "https://www.bilibili.com/video/BVASRTEST",
      pages: [{ page: 1, cid: 100, part: "P1", duration: 20 }]
    },
    transcript: {
      original: {
        source: "bilibili",
        status: "ready",
        pages: [{
          page: 1,
          cid: 100,
          part: "P1",
          duration: 20,
          subtitles: [{ id: "bili-track", label: "公开字幕", languageName: "中文", body: [{ index: 0, from: 0, to: 1, content: "原始 B 站字幕" }] }]
        }]
      },
      polished: { status: "not_generated", variants: {}, segments: [] },
    },
    outline: { status: "not_generated", tree: null },
    mindmap: { status: "not_generated", tree: null },
    record: { html: "", plainText: "", revision: 0 },
    speaker: { status: "not_started", segments: [], labels: {} },
    processing: { subtitle: "ready", ai: "not_started", asr: "not_started", diarization: "not_started" },
    settings: { processingEngine: "none", provider: "", model: "" }
  };
}

test("ASR 字幕作为独立轨道保存，不覆盖已有 B 站原文", () => {
  const note = makeNote();
  workspace.saveNote(note);
  const { task } = workspace.createAsrTask(note, { pageIndex: 0 });
  const saved = workspace.saveAsrTranscript(note, task, {
    ok: true,
    model: "paraformer-zh",
    vadModel: "fsmn-vad",
    puncModel: "ct-punc",
    device: "cpu",
    elapsedMs: 1234,
    segments: [
      { id: "asr-seg-000001", from: 0.2, to: 2.4, text: "本地识别第一句。" },
      { id: "asr-seg-000002", from: 2.5, to: 5.8, text: "本地识别第二句。" }
    ]
  }, "/tmp/asr-test.wav");

  const tracks = saved.transcript.original.pages[0].subtitles;
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].id, "bili-track");
  assert.equal(tracks[0].body[0].content, "原始 B 站字幕");
  assert.equal(tracks[1].source, "funasr");
  assert.deepEqual(tracks[1].body.map(({ id, from, to, text }) => ({ id, from, to, text })), [
    { id: "asr-seg-000001", from: 0.2, to: 2.4, text: "本地识别第一句。" },
    { id: "asr-seg-000002", from: 2.5, to: 5.8, text: "本地识别第二句。" }
  ]);
  assert.deepEqual(saved.transcript.original.sources.sort(), ["bilibili", "funasr"]);
  assert.equal(saved.processing.asr, "ready");
  assert.equal(saved.processing.diarization, "not_started");
});

test("ASR 失败保存阶段和可读原因，同时保留笔记原字幕", async () => {
  const note = makeNote("note_asrfailure");
  workspace.saveNote(note);
  const { task } = workspace.createAsrTask(note, { pageIndex: 0 });
  const originalSnapshot = JSON.stringify(note.transcript.original);
  const failed = await workspace.runTask(task, async () => {
    task.meta.stage = "preprocess";
    const error = new Error("模拟 FFmpeg 转换失败");
    error.code = "ASR_PREPROCESS_FAILED";
    throw error;
  });
  assert.equal(failed.status, "failed");
  const preserved = workspace.loadNote(note.id);
  assert.equal(JSON.stringify(preserved.transcript.original), originalSnapshot);
  assert.equal(preserved.processing.asr, "failed");
  assert.equal(preserved.asr.failedStage, "preprocess");
  assert.equal(preserved.asr.error.code, "ASR_PREPROCESS_FAILED");
});

test.after(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
});
