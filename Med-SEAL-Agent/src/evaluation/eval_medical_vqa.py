"""Evaluation utilities for medical VQA accuracy and report generation metrics.

Provides three evaluation workflows:

1. **VQA accuracy** (PathVQA, VQA-RAD):
   - Yes/No questions: classify both prediction and reference, compare labels.
   - Open-ended questions: normalised exact-match comparison.
   - Reports overall, yes/no, and open-ended accuracy.

2. **Report generation** (MIMIC-CXR):
   - Corpus-level BLEU-1 / BLEU-4 via NLTK.
   - ROUGE-1 / ROUGE-2 / ROUGE-L via ``rouge-score``.

3. **Low-level helpers** reused by both workflows:
   - ``generate_answer``: single-sample greedy decoding with Qwen3-VL processor.
   - ``normalize_answer``: canonical form for string comparison.
"""

from __future__ import annotations

import json
import logging
import re
import string
from collections import defaultdict
from pathlib import Path

import torch
from PIL import Image
from tqdm import tqdm

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Answer normalisation
# ---------------------------------------------------------------------------

_ARTICLES_RE = re.compile(r"\b(a|an|the)\b")
_THINK_RE = re.compile(r"<think>.*?</think>", flags=re.DOTALL)
_THINK_OPEN_RE = re.compile(r"<think>.*", flags=re.DOTALL)
_THINK_CLOSE_RE = re.compile(r"^.*?</think>\s*", flags=re.DOTALL)
_PUNCT_TABLE = str.maketrans("", "", string.punctuation)

_YES_WORDS = frozenset({"yes", "true", "correct", "right", "positive", "1"})
_NO_WORDS = frozenset({"no", "false", "incorrect", "wrong", "negative", "0"})
_YN_ALL = _YES_WORDS | _NO_WORDS


def normalize_answer(text: str) -> str:
    """Lower-case, strip thinking blocks / articles / punctuation / whitespace."""
    text = extract_answer(text)
    text = text.lower().strip()
    text = _ARTICLES_RE.sub(" ", text)
    text = text.translate(_PUNCT_TABLE)
    return " ".join(text.split())


def token_f1(prediction: str, reference: str) -> float:
    """Compute token-level F1 between normalised prediction and reference."""
    pred_tokens = normalize_answer(prediction).split()
    ref_tokens = normalize_answer(reference).split()
    if not pred_tokens or not ref_tokens:
        return 0.0
    common = set(pred_tokens) & set(ref_tokens)
    if not common:
        return 0.0
    precision = len(common) / len(pred_tokens)
    recall = len(common) / len(ref_tokens)
    return 2 * precision * recall / (precision + recall)


def extract_answer(text: str) -> str:
    """Strip thinking blocks from model output, handling partial tags."""
    text = _THINK_RE.sub("", text)
    text = _THINK_CLOSE_RE.sub("", text)
    text = _THINK_OPEN_RE.sub("", text)
    return text.strip()


def classify_yes_no(text: str) -> str | None:
    """Return ``'yes'``, ``'no'``, or ``None`` for open-ended answers."""
    words = normalize_answer(text).split()
    if not words:
        return None
    first = words[0]
    if first in _YES_WORDS:
        return "yes"
    if first in _NO_WORDS:
        return "no"
    word_set = set(words)
    if word_set & _YES_WORDS:
        return "yes"
    if word_set & _NO_WORDS:
        return "no"
    return None


def is_yes_no_question(reference: str) -> bool:
    """``True`` if the ground-truth answer is a yes/no keyword."""
    return normalize_answer(reference) in _YN_ALL


# ---------------------------------------------------------------------------
# Message formatting
# ---------------------------------------------------------------------------


def _build_eval_messages(image_path: str, question: str) -> list[dict]:
    """Build a single-turn Qwen3-VL user message for inference."""
    text = question.replace("<image>\n", "").replace("<image>", "").strip()
    return [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": f"file://{image_path}"},
                {"type": "text", "text": text},
            ],
        }
    ]


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------


@torch.inference_mode()
def generate_answer(
    model,
    processor,
    image_path: str,
    question: str,
    *,
    max_new_tokens: int = 512,
    device: str | torch.device = "cuda",
) -> str:
    """Run greedy decoding for a single VQA sample and return the answer string."""
    messages = _build_eval_messages(image_path, question)
    prompt = processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    image = Image.open(image_path).convert("RGB")
    inputs = processor(
        text=[prompt], images=[image], return_tensors="pt", padding=True
    )
    inputs = {
        k: v.to(device) if isinstance(v, torch.Tensor) else v
        for k, v in inputs.items()
    }

    output_ids = model.generate(
        **inputs,
        max_new_tokens=max_new_tokens,
        do_sample=False,
    )
    generated_ids = output_ids[0, inputs["input_ids"].shape[1] :]
    raw = processor.tokenizer.decode(generated_ids, skip_special_tokens=True)
    return extract_answer(raw)


# ---------------------------------------------------------------------------
# JSONL loader
# ---------------------------------------------------------------------------


def _load_jsonl(path: str | Path, max_samples: int | None = None) -> list[dict]:
    records: list[dict] = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    if max_samples is not None:
        records = records[:max_samples]
    return records


# ---------------------------------------------------------------------------
# VQA evaluation (PathVQA / VQA-RAD)
# ---------------------------------------------------------------------------


def evaluate_vqa(
    model,
    processor,
    jsonl_path: str | Path,
    *,
    max_new_tokens: int = 256,
    max_samples: int | None = None,
    device: str | torch.device = "cuda",
) -> dict:
    """Compute VQA accuracy over a test JSONL split.

    Returns
    -------
    dict
        ``accuracy``, ``yes_no_accuracy``, ``open_accuracy`` (floats in 0--1),
        raw counts, and a ``predictions`` list with per-sample details.
    """
    samples = _load_jsonl(jsonl_path, max_samples)
    logger.info("Evaluating VQA on %d samples from %s", len(samples), jsonl_path)

    total = correct = 0
    yn_total = yn_correct = 0
    open_total = open_correct = 0
    open_f1_sum = 0.0
    predictions: list[dict] = []

    for sample in tqdm(samples, desc=f"VQA [{Path(jsonl_path).parent.name}]"):
        image_path = sample["image"]
        convos = sample["conversations"]
        question = convos[0]["content"]
        reference = convos[1]["content"]

        try:
            raw_prediction = generate_answer(
                model,
                processor,
                image_path,
                question,
                max_new_tokens=max_new_tokens,
                device=device,
            )
        except Exception:
            logger.warning(
                "Generation failed for %s -- skipping", image_path, exc_info=True
            )
            raw_prediction = ""

        prediction = extract_answer(raw_prediction)

        is_yn = is_yes_no_question(reference)
        f1 = 0.0
        if is_yn:
            yn_total += 1
            match = classify_yes_no(reference) == classify_yes_no(prediction)
            if match:
                yn_correct += 1
        else:
            open_total += 1
            match = normalize_answer(prediction) == normalize_answer(reference)
            f1 = token_f1(prediction, reference)
            open_f1_sum += f1
            if match:
                open_correct += 1

        total += 1
        if match:
            correct += 1

        pred_entry = {
            "image": image_path,
            "question": question,
            "reference": reference,
            "prediction": prediction,
            "correct": match,
            "type": "yes_no" if is_yn else "open",
        }
        if not is_yn:
            pred_entry["token_f1"] = round(f1, 4)
        predictions.append(pred_entry)

    return {
        "total": total,
        "correct": correct,
        "accuracy": correct / total if total else 0.0,
        "yes_no_total": yn_total,
        "yes_no_correct": yn_correct,
        "yes_no_accuracy": yn_correct / yn_total if yn_total else 0.0,
        "open_total": open_total,
        "open_correct": open_correct,
        "open_accuracy": open_correct / open_total if open_total else 0.0,
        "open_token_f1": open_f1_sum / open_total if open_total else 0.0,
        "predictions": predictions,
    }


# ---------------------------------------------------------------------------
# Report generation metrics (MIMIC-CXR)
# ---------------------------------------------------------------------------


def compute_report_metrics(
    predictions: list[str],
    references: list[str],
) -> dict[str, float]:
    """Return corpus-level BLEU-1/4 and ROUGE-1/2/L for generated reports."""
    from rouge_score import rouge_scorer as _rouge_scorer
    import nltk
    from nltk.translate.bleu_score import corpus_bleu, SmoothingFunction

    try:
        nltk.data.find("tokenizers/punkt_tab")
    except LookupError:
        nltk.download("punkt_tab", quiet=True)

    # ROUGE
    scorer = _rouge_scorer.RougeScorer(
        ["rouge1", "rouge2", "rougeL"], use_stemmer=True
    )
    rouge_accum: dict[str, list[float]] = defaultdict(list)
    for pred, ref in zip(predictions, references):
        scores = scorer.score(ref, pred)
        for key, val in scores.items():
            rouge_accum[key].append(val.fmeasure)

    rouge_results = {
        k: sum(v) / len(v) if v else 0.0 for k, v in rouge_accum.items()
    }

    # BLEU
    refs_tok = [[nltk.word_tokenize(r.lower())] for r in references]
    preds_tok = [nltk.word_tokenize(p.lower()) for p in predictions]
    smooth = SmoothingFunction().method1

    bleu_1 = corpus_bleu(
        refs_tok, preds_tok, weights=(1, 0, 0, 0), smoothing_function=smooth
    )
    bleu_4 = corpus_bleu(
        refs_tok,
        preds_tok,
        weights=(0.25, 0.25, 0.25, 0.25),
        smoothing_function=smooth,
    )

    return {"bleu_1": bleu_1, "bleu_4": bleu_4, **rouge_results}


def evaluate_report_generation(
    model,
    processor,
    jsonl_path: str | Path,
    *,
    max_new_tokens: int = 512,
    max_samples: int | None = None,
    device: str | torch.device = "cuda",
) -> dict:
    """Compute BLEU/ROUGE on a report-generation test JSONL.

    Returns
    -------
    dict
        ``bleu_1``, ``bleu_4``, ``rouge1``, ``rouge2``, ``rougeL``,
        ``num_samples``, and a ``predictions`` list.
    """
    samples = _load_jsonl(jsonl_path, max_samples)
    logger.info(
        "Evaluating report generation on %d samples from %s",
        len(samples),
        jsonl_path,
    )

    pred_texts: list[str] = []
    ref_texts: list[str] = []
    predictions: list[dict] = []

    for sample in tqdm(samples, desc="Reports [mimic-cxr]"):
        image_path = sample["image"]
        convos = sample["conversations"]
        question = convos[0]["content"]
        reference = convos[1]["content"]

        try:
            prediction = generate_answer(
                model,
                processor,
                image_path,
                question,
                max_new_tokens=max_new_tokens,
                device=device,
            )
        except Exception:
            logger.warning(
                "Generation failed for %s -- skipping", image_path, exc_info=True
            )
            prediction = ""

        pred_texts.append(prediction)
        ref_texts.append(reference)
        predictions.append(
            {
                "image": image_path,
                "question": question,
                "reference": reference,
                "prediction": prediction,
            }
        )

    metrics = compute_report_metrics(pred_texts, ref_texts) if pred_texts else {}
    metrics["num_samples"] = len(pred_texts)
    metrics["predictions"] = predictions
    return metrics
