#!/usr/bin/env python3
"""Local FunASR worker.

Only machine-readable JSON is written to stdout. Library logs remain on stderr so
the Node process can safely consume progress events and the final result file.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any


MODEL_CACHE_NAMES = {
    "paraformer-zh": "iic--speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    "fsmn-vad": "iic--speech_fsmn_vad_zh-cn-16k-common-pytorch",
    "ct-punc": "iic--punc_ct-transformer_cn-en-common-vocab471067-large",
    "cam++": "iic--speech_campplus_sv_zh-cn_16k-common",
}


def emit(event_type: str, **payload: Any) -> None:
    print(json.dumps({"type": event_type, **payload}, ensure_ascii=False), flush=True)


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def resolve_cached_model(cache_dir: str, model_name: str) -> str:
    if not cache_dir:
        return model_name
    candidate_name = MODEL_CACHE_NAMES.get(model_name, model_name.replace("/", "--"))
    snapshot = Path(cache_dir).expanduser().resolve() / "models" / candidate_name / "snapshots" / "master"
    has_config = (snapshot / "config.yaml").is_file() or (snapshot / "configuration.json").is_file()
    has_weights = any(snapshot.glob("*.pt")) or any(snapshot.glob("*.bin")) or any(snapshot.glob("*.safetensors"))
    return str(snapshot) if has_config and has_weights else model_name


def text_weight(value: str) -> int:
    without_punctuation = re.sub(r"[\s，。！？、；：,.!?;:'\"“”‘’（）()《》【】\[\]—…-]+", "", value)
    words = re.findall(r"[A-Za-z0-9]+|[\u3400-\u9fff]", without_punctuation)
    return max(1, len(words))


def split_long_sentence(value: str, max_chars: int = 70) -> list[str]:
    value = clean_text(value)
    if len(value) <= max_chars:
        return [value] if value else []
    pieces = [clean_text(item) for item in re.split(r"(?<=[，,；;：:])", value) if clean_text(item)]
    output: list[str] = []
    current = ""
    for piece in pieces or [value]:
        if current and len(current) + len(piece) > max_chars:
            output.append(current)
            current = piece
        else:
            current += piece
    if current:
        output.append(current)
    return output


def split_sentences(value: str) -> list[str]:
    raw = clean_text(value)
    if not raw:
        return []
    sentences = [clean_text(item) for item in re.split(r"(?<=[。！？!?；;])", raw) if clean_text(item)]
    return [piece for sentence in sentences for piece in split_long_sentence(sentence)]


def timestamp_segments(item: dict[str, Any]) -> list[dict[str, Any]]:
    sentence_info = item.get("sentence_info")
    if isinstance(sentence_info, list) and sentence_info:
        output = []
        for sentence in sentence_info:
            text = clean_text(sentence.get("text"))
            start = sentence.get("start")
            end = sentence.get("end")
            if text and isinstance(start, (int, float)) and isinstance(end, (int, float)) and end > start:
                output.append({"from": float(start) / 1000, "to": float(end) / 1000, "text": text})
        if output:
            return output

    timestamps = item.get("timestamp")
    text = clean_text(item.get("text"))
    if not text or not isinstance(timestamps, list) or not timestamps:
        return []
    valid = [stamp for stamp in timestamps if isinstance(stamp, (list, tuple)) and len(stamp) >= 2]
    if not valid:
        return []
    sentences = split_sentences(text) or [text]
    weights = [text_weight(sentence) for sentence in sentences]
    total_weight = sum(weights)
    cursor = 0
    output = []
    cumulative = 0
    for index, (sentence, weight) in enumerate(zip(sentences, weights)):
        cumulative += weight
        end_index = len(valid) if index == len(sentences) - 1 else max(cursor + 1, round(len(valid) * cumulative / total_weight))
        end_index = min(len(valid), end_index)
        first = valid[cursor]
        last = valid[end_index - 1]
        output.append({"from": float(first[0]) / 1000, "to": float(last[1]) / 1000, "text": sentence})
        cursor = end_index
    return output


def normalize_results(results: Any) -> list[dict[str, Any]]:
    rows = results if isinstance(results, list) else [results]
    raw_segments = [segment for item in rows if isinstance(item, dict) for segment in timestamp_segments(item)]
    normalized = []
    previous_to = 0.0
    for index, segment in enumerate(raw_segments):
        start = max(previous_to if segment["from"] < previous_to - 0.25 else 0.0, float(segment["from"]))
        end = max(start + 0.08, float(segment["to"]))
        normalized.append({
            "id": f"asr-seg-{index + 1:06d}",
            "from": round(start, 3),
            "to": round(end, 3),
            "text": clean_text(segment["text"]),
        })
        previous_to = end
    return [segment for segment in normalized if segment["text"]]


def normalize_speaker_results(results: Any) -> list[dict[str, Any]]:
    rows = results if isinstance(results, list) else [results]
    raw: list[dict[str, Any]] = []
    for item in rows:
        if not isinstance(item, dict):
            continue
        for sentence in item.get("sentence_info") or []:
            if not isinstance(sentence, dict) or sentence.get("spk") is None:
                continue
            start = sentence.get("start")
            end = sentence.get("end")
            if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or end <= start:
                continue
            confidence = sentence.get("confidence", sentence.get("score"))
            raw.append({
                "rawSpeaker": str(sentence.get("spk")),
                "from": float(start) / 1000,
                "to": float(end) / 1000,
                "confidence": float(confidence) if isinstance(confidence, (int, float)) else None,
            })
    raw.sort(key=lambda segment: (segment["from"], segment["to"]))
    speaker_ids: dict[str, str] = {}
    normalized: list[dict[str, Any]] = []
    for segment in raw:
        speaker_id = speaker_ids.setdefault(segment["rawSpeaker"], f"speaker_{len(speaker_ids) + 1:02d}")
        normalized.append({
            "speakerId": speaker_id,
            "from": round(segment["from"], 3),
            "to": round(segment["to"], 3),
            "confidence": round(segment["confidence"], 4) if segment["confidence"] is not None else None,
        })
    return normalized


def diagnose() -> int:
    result: dict[str, Any] = {"ok": True, "python": sys.version.split()[0], "platform": sys.platform}
    try:
        import torch

        result["torch"] = torch.__version__
        result["mpsAvailable"] = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())
    except Exception as error:  # pragma: no cover - exercised by the Node diagnostics path
        result.update({"ok": False, "torchError": str(error)})
    try:
        import funasr

        result["funasr"] = getattr(funasr, "__version__", "unknown")
    except Exception as error:  # pragma: no cover
        result.update({"ok": False, "funasrError": str(error)})
    emit("diagnostics", **result)
    return 0 if result["ok"] else 2


def transcribe(args: argparse.Namespace) -> int:
    started = time.monotonic()
    if args.model_cache_dir:
        cache = str(Path(args.model_cache_dir).expanduser().resolve())
        Path(cache).mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("MODELSCOPE_CACHE", cache)
    emit("progress", stage="model_loading", progress=58, message="正在加载本地 ASR 模型；首次运行会下载模型")
    try:
        from funasr import AutoModel

        model_kwargs: dict[str, Any] = {
            "model": resolve_cached_model(args.model_cache_dir, args.model),
            "vad_model": resolve_cached_model(args.model_cache_dir, args.vad_model),
            "vad_kwargs": {"max_single_segment_time": args.max_vad_segment_ms},
            "punc_model": resolve_cached_model(args.model_cache_dir, args.punc_model),
            "device": args.device,
            "ncpu": args.cpu_threads,
            "disable_update": True,
            "disable_pbar": True,
        }
        if args.diarize:
            model_kwargs["spk_model"] = resolve_cached_model(args.model_cache_dir, args.speaker_model)
        model = AutoModel(
            **model_kwargs,
        )
        emit("progress", stage="vad", progress=64, message="正在用 FSMN-VAD 切分长音频")
        if args.diarize:
            emit("progress", stage="speaker_embedding", progress=68, message="正在提取 CAM++ 说话人特征并聚类")
        else:
            emit("progress", stage="asr", progress=68, message="正在执行 Paraformer 识别；标点模型会在识别后接续处理")
        generate_kwargs: dict[str, Any] = {
            "input": str(Path(args.input).resolve()),
            "batch_size_s": args.batch_size_s,
            "sentence_timestamp": True,
        }
        if args.diarize:
            generate_kwargs["return_spk_res"] = True
            if args.preset_speakers > 0:
                generate_kwargs["preset_spk_num"] = args.preset_speakers
        results = model.generate(
            **generate_kwargs,
        )
        segments = normalize_results(results)
        speaker_segments = normalize_speaker_results(results) if args.diarize else []
        emit("progress", stage="clustering" if args.diarize else "punctuation", progress=89, message="说话人聚类已完成，正在对齐已有文字" if args.diarize else "CT-Punc 标点恢复已完成，正在整理时间轴")
        if not segments:
            raise RuntimeError("FunASR 没有返回可用的带时间戳文本")
        if args.diarize and not speaker_segments:
            raise RuntimeError("CAM++ 没有返回可用的说话人时间区间")
        payload = {
            "ok": True,
            "segments": segments,
            "model": args.model,
            "vadModel": args.vad_model,
            "puncModel": args.punc_model,
            "device": args.device,
            "elapsedMs": round((time.monotonic() - started) * 1000),
        }
        if args.diarize:
            payload.update({
                "speakerSegments": speaker_segments,
                "speakerModel": args.speaker_model,
                "speakerCount": len({segment["speakerId"] for segment in speaker_segments}),
            })
        output = Path(args.output).resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_suffix(output.suffix + ".tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(output)
        emit("result", stage="completed", progress=92, message=f"说话人识别完成，共 {payload.get('speakerCount', 0)} 位" if args.diarize else f"识别完成，共 {len(segments)} 段", segmentCount=len(segments), speakerCount=payload.get("speakerCount", 0))
        return 0
    except Exception as error:
        emit("error", stage="funasr", code="FUNASR_FAILED", message=clean_text(error))
        return 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--diagnose", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--model", default="paraformer-zh")
    parser.add_argument("--vad-model", default="fsmn-vad")
    parser.add_argument("--punc-model", default="ct-punc")
    parser.add_argument("--diarize", action="store_true")
    parser.add_argument("--speaker-model", default="cam++")
    parser.add_argument("--preset-speakers", type=int, default=0)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--model-cache-dir", default="")
    parser.add_argument("--cpu-threads", type=int, default=max(1, min(6, os.cpu_count() or 4)))
    parser.add_argument("--batch-size-s", type=int, default=120)
    parser.add_argument("--max-vad-segment-ms", type=int, default=30000)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.diagnose:
        return diagnose()
    if not args.input or not args.output:
        emit("error", stage="arguments", code="INVALID_ARGUMENTS", message="缺少 --input 或 --output")
        return 2
    return transcribe(args)


if __name__ == "__main__":
    raise SystemExit(main())
