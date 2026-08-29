"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Readable } = require("node:stream");
const test = require("node:test");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-note-douyin-"));
process.env.VIDEO_NOTE_DATA_DIR = testDataDir;
const workspace = require("../server");

const douyinUrl = "https://www.douyin.com/video/7481234567890123456";

function mockMetadata() {
  return {
    id: "7481234567890123456",
    webpage_url: douyinUrl,
    title: "抖音流程测试视频",
    description: "用于验证抖音导入流程",
    uploader: "测试作者",
    thumbnail: "https://p3-sign.douyinpic.com/test.jpeg",
    duration: 36
  };
}

test("识别 B站和抖音链接，并支持带分享文案的抖音短链接", () => {
  assert.equal(workspace.detectVideoProvider("BV1TEST123"), "bilibili");
  assert.equal(workspace.detectVideoProvider("https://www.bilibili.com/video/BV1TEST123"), "bilibili");
  assert.equal(workspace.detectVideoProvider(douyinUrl), "douyin");
  assert.equal(workspace.detectVideoProvider("复制打开抖音 https://v.douyin.com/AbCd123/ 看视频"), "douyin");
  assert.throws(() => workspace.detectVideoProvider("https://example.com/video/1"), (error) => error.code === "UNSUPPORTED_VIDEO_PROVIDER");
});

test("抖音元数据归一化为单视频笔记，后续流程等待本地 ASR", async () => {
  workspace.setYtDlpMetadataOverrideForTests(async () => mockMetadata());
  const source = await workspace.loadDouyinSource(douyinUrl);
  assert.equal(source.source.provider, "douyin");
  assert.equal(source.source.sourceId, "7481234567890123456");
  assert.equal(source.source.title, "抖音流程测试视频");
  assert.equal(source.stats.pageCount, 1);
  assert.equal(source.stats.segmentCount, 0);
  assert.equal(source.subtitleStatus, "missing");

  const note = workspace.buildNoteFromSource(source);
  assert.equal(note.schemaVersion, 2);
  assert.equal(note.status, "waiting_asr");
  assert.equal(note.transcript.original.status, "missing");
  assert.equal(workspace.sourceKey(note), "douyin:7481234567890123456");
  workspace.setYtDlpMetadataOverrideForTests(null);
});

test("抖音解析受限时仍可用完整 VideoID 创建待处理笔记", async () => {
  workspace.setYtDlpMetadataOverrideForTests(async () => {
    const error = new Error("需要 Cookie");
    error.code = "DOUYIN_COOKIE_REQUIRED";
    throw error;
  });
  const source = await workspace.loadDouyinSource(douyinUrl);
  assert.equal(source.metadataStatus, "partial");
  assert.equal(source.source.videoId, "7481234567890123456");
  assert.match(source.metadataError, /需要 Cookie/);
  workspace.setYtDlpMetadataOverrideForTests(null);
});

test("本地媒体上传支持 Range 播放，并保存到抖音笔记", async () => {
  workspace.setYtDlpMetadataOverrideForTests(async () => mockMetadata());
  const source = await workspace.loadDouyinSource(douyinUrl);
  const note = workspace.buildNoteFromSource(source);
  workspace.saveNote(note);
  workspace.setYtDlpMetadataOverrideForTests(null);

  const mediaBytes = Buffer.from("0123456789abcdef");
  const uploadRequest = Readable.from([mediaBytes]);
  uploadRequest.headers = { "content-type": "video/mp4", "x-file-name": "sample.mp4", "content-length": String(mediaBytes.length) };
  const uploaded = await workspace.receiveNoteMedia(note, uploadRequest);
  assert.equal(uploaded.media.status, "ready");
  assert.equal(uploaded.media.bytes, mediaBytes.length);

  const response = new PassThrough();
  response.statusCode = 0;
  response.responseHeaders = {};
  response.writeHead = (statusCode, headers) => {
    response.statusCode = statusCode;
    response.responseHeaders = headers;
    return response;
  };
  const chunks = [];
  response.on("data", (chunk) => chunks.push(chunk));
  const completed = new Promise((resolve) => response.on("end", resolve));
  workspace.serveNoteMedia(uploaded, { headers: { range: "bytes=4-7" } }, response);
  await completed;
  assert.equal(response.statusCode, 206);
  assert.equal(response.responseHeaders["Content-Range"], "bytes 4-7/16");
  assert.equal(Buffer.concat(chunks).toString(), "4567");
});

test.after(() => {
  workspace.setYtDlpMetadataOverrideForTests(null);
  fs.rmSync(testDataDir, { recursive: true, force: true });
});
