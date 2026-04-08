#!/usr/bin/env python3
"""Download and convert medical VQA datasets into unified JSONL chat format.

Datasets
--------
1. PathVQA        HuggingFace: flaviagiammarino/path-vqa                (~32 K QA pairs)
2. VQA-RAD        HuggingFace: flaviagiammarino/vqa-rad                 (~3.5K QA pairs)
3. PubMedVision   HuggingFace: FreedomIntelligence/PubMedVision         (~647K pairs)
4. MIMIC-CXR      Local PhysioNet download                              (~227K CXR-report pairs)

Output format  (one JSON object per line)
-----------------------------------------
{
  "image": "/absolute/path/to/image.jpg",
  "conversations": [
    {"role": "user",      "content": "<image>\\nQuestion text"},
    {"role": "assistant", "content": "Answer text"}
  ]
}

Usage
-----
# All HuggingFace datasets (PathVQA + VQA-RAD + PubMedVision):
python scripts/prepare_datasets.py --output-dir data/

# Specific datasets only:
python scripts/prepare_datasets.py --output-dir data/ --datasets pathvqa vqarad

# PubMedVision (requires pre-downloaded & extracted images):
python scripts/prepare_datasets.py --output-dir data/ --datasets pubmedvision \
    --pubmedvision-images-dir /path/to/pubmedvision/images/

# MIMIC-CXR (requires local PhysioNet download):
python scripts/prepare_datasets.py --output-dir data/ --datasets mimic-cxr \
    --mimic-cxr-jpg-dir /path/to/mimic-cxr-jpg/2.0.0 \
    --mimic-cxr-reports-dir /path/to/mimic-cxr/2.0.0/files
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

from datasets import load_dataset
from PIL import Image
from tqdm import tqdm

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("prepare_datasets")

ALL_DATASETS = ["pathvqa", "vqarad", "pubmedvision", "mimic-cxr"]
HF_DATASETS = ["pathvqa", "vqarad", "pubmedvision"]

MIMIC_PROMPTS = [
    "Describe this chest X-ray.",
    "What are the findings in this chest X-ray?",
    "Provide a radiology report for this chest X-ray image.",
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_entry(image_path: str, question: str, answer: str) -> dict:
    """Build a single-turn VQA conversation in unified format."""
    return {
        "image": image_path,
        "conversations": [
            {"role": "user", "content": f"<image>\n{question}"},
            {"role": "assistant", "content": answer},
        ],
    }


def save_pil_image(img: Image.Image, path: Path) -> None:
    """Save a PIL Image to *path* (JPEG, quality 95). Skips if file exists."""
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    if img.mode != "RGB":
        img = img.convert("RGB")
    img.save(path, "JPEG", quality=95)


def write_jsonl(records: list[dict], path: Path) -> int:
    """Write *records* as JSONL. Returns the number of records written."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return len(records)


# ---------------------------------------------------------------------------
# PathVQA
# ---------------------------------------------------------------------------


def prepare_pathvqa(output_dir: Path, cache_dir: Path | None = None) -> dict[str, int]:
    """Download flaviagiammarino/path-vqa and convert to JSONL.

    Splits: train / validation / test.
    Columns: image (PIL), question (str), answer (str).
    """
    logger.info("Preparing PathVQA ...")
    ds = load_dataset("flaviagiammarino/path-vqa", cache_dir=cache_dir)
    images_root = output_dir / "pathvqa" / "images"
    counts: dict[str, int] = {}

    for split in ds:
        records = []
        img_dir = images_root / split
        img_dir.mkdir(parents=True, exist_ok=True)

        for idx, row in enumerate(tqdm(ds[split], desc=f"PathVQA/{split}")):
            img_path = img_dir / f"{idx:06d}.jpg"
            save_pil_image(row["image"], img_path)
            records.append(
                make_entry(str(img_path.resolve()), row["question"], str(row["answer"]))
            )

        jsonl_path = output_dir / "pathvqa" / f"{split}.jsonl"
        write_jsonl(records, jsonl_path)
        counts[split] = len(records)
        logger.info("  PathVQA/%s: %d examples -> %s", split, len(records), jsonl_path)

    return counts


# ---------------------------------------------------------------------------
# VQA-RAD
# ---------------------------------------------------------------------------


def prepare_vqarad(output_dir: Path, cache_dir: Path | None = None) -> dict[str, int]:
    """Download flaviagiammarino/vqa-rad and convert to JSONL.

    Splits: train / test  (no official validation split).
    Columns: image (PIL), question (str), answer (str).
    """
    logger.info("Preparing VQA-RAD ...")
    ds = load_dataset("flaviagiammarino/vqa-rad", cache_dir=cache_dir)
    images_root = output_dir / "vqarad" / "images"
    counts: dict[str, int] = {}

    for split in ds:
        records = []
        img_dir = images_root / split
        img_dir.mkdir(parents=True, exist_ok=True)

        for idx, row in enumerate(tqdm(ds[split], desc=f"VQA-RAD/{split}")):
            img_path = img_dir / f"{idx:06d}.jpg"
            save_pil_image(row["image"], img_path)
            records.append(
                make_entry(str(img_path.resolve()), row["question"], str(row["answer"]))
            )

        jsonl_path = output_dir / "vqarad" / f"{split}.jsonl"
        write_jsonl(records, jsonl_path)
        counts[split] = len(records)
        logger.info("  VQA-RAD/%s: %d examples -> %s", split, len(records), jsonl_path)

    return counts


# ---------------------------------------------------------------------------
# PubMedVision
# ---------------------------------------------------------------------------

PUBMEDVISION_ROLE_MAP = {"human": "user", "gpt": "assistant"}


def prepare_pubmedvision(
    output_dir: Path,
    images_dir: Path,
    cache_dir: Path | None = None,
) -> dict[str, int]:
    """Download FreedomIntelligence/PubMedVision (Alignment VQA) and convert.

    The HF dataset stores image paths as relative strings (e.g.
    ``images/pmc_1_0.jpg``) inside a ``Sequence[string]`` column.  The actual
    image files must be downloaded separately (``images_*.zip`` from the HF
    repo) and extracted into *images_dir*.

    Conversations arrive as ``{"from": "human"/"gpt", "value": "..."}`` and
    are re-keyed to ``{"role": "user"/"assistant", "content": "..."}``.

    Multi-image entries use only the first image to keep the unified format
    (single ``"image"`` field per record).  An ``<image>`` tag is prepended
    to the first user turn.

    Only the ``train`` split is available upstream (~647 K examples).
    """
    logger.info("Preparing PubMedVision ...")

    if not images_dir.is_dir():
        logger.error(
            "PubMedVision images directory does not exist: %s  "
            "Download and extract images_*.zip from the HF repo first.",
            images_dir,
        )
        sys.exit(1)

    ds = load_dataset(
        "FreedomIntelligence/PubMedVision",
        name="PubMedVision_Alignment_VQA",
        cache_dir=cache_dir,
    )

    counts: dict[str, int] = {}
    skipped_no_image = 0
    multi_image_count = 0

    for split in ds:
        records = []
        for row in tqdm(ds[split], desc=f"PubMedVision/{split}"):
            img_list = row.get("image") or []
            if not img_list:
                skipped_no_image += 1
                continue

            if len(img_list) > 1:
                multi_image_count += 1

            img_rel = img_list[0]
            img_path = images_dir / img_rel
            if not img_path.exists():
                img_path = images_dir / Path(img_rel).name
            if not img_path.exists():
                skipped_no_image += 1
                continue

            convos = row.get("conversations") or []
            if len(convos) < 2:
                continue

            unified_convos = []
            for i, turn in enumerate(convos):
                role = PUBMEDVISION_ROLE_MAP.get(turn["from"], turn["from"])
                content = turn["value"]
                if i == 0 and role == "user":
                    content = f"<image>\n{content}"
                unified_convos.append({"role": role, "content": content})

            records.append(
                {
                    "image": str(img_path.resolve()),
                    "conversations": unified_convos,
                }
            )

        jsonl_path = output_dir / "pubmedvision" / f"{split}.jsonl"
        write_jsonl(records, jsonl_path)
        counts[split] = len(records)
        logger.info(
            "  PubMedVision/%s: %d examples -> %s", split, len(records), jsonl_path
        )

    if skipped_no_image:
        logger.warning(
            "  PubMedVision: skipped %d entries (image file not found)", skipped_no_image
        )
    if multi_image_count:
        logger.info(
            "  PubMedVision: %d entries had multiple images (used first only)",
            multi_image_count,
        )

    return counts


# ---------------------------------------------------------------------------
# MIMIC-CXR
# ---------------------------------------------------------------------------


def _parse_mimic_report(report_path: Path) -> str | None:
    """Extract FINDINGS and IMPRESSION from a MIMIC-CXR free-text report.

    Falls back to the full report text if those sections are absent.
    Returns ``None`` for empty / too-short reports.
    """
    if not report_path.exists():
        return None
    text = report_path.read_text(encoding="utf-8")
    if not text.strip():
        return None

    sections: dict[str, str] = {}
    current_section: str | None = None
    current_lines: list[str] = []

    for line in text.split("\n"):
        stripped = line.strip()
        match = re.match(r"^([A-Z][A-Z\s/\-]+):(.*)$", stripped)
        if match:
            if current_section is not None:
                sections[current_section] = "\n".join(current_lines).strip()
            current_section = match.group(1).strip()
            remainder = match.group(2).strip()
            current_lines = [remainder] if remainder else []
        elif current_section is not None:
            current_lines.append(line)

    if current_section is not None:
        sections[current_section] = "\n".join(current_lines).strip()

    parts = []
    for key in ("FINDINGS", "IMPRESSION"):
        if key in sections and sections[key]:
            parts.append(f"{key}:\n{sections[key]}")
    if parts:
        return "\n\n".join(parts)

    clean = text.strip()
    return clean if len(clean) > 30 else None


def prepare_mimic_cxr(
    output_dir: Path,
    jpg_dir: Path,
    reports_dir: Path,
) -> dict[str, int]:
    """Convert a local MIMIC-CXR-JPG + reports download to JSONL.

    Expected files inside *jpg_dir*:
        mimic-cxr-2.0.0-split.csv
        mimic-cxr-2.0.0-metadata.csv
        files/p{group}/p{subject_id}/s{study_id}/{dicom_id}.jpg

    Expected files inside *reports_dir*:
        p{group}/p{subject_id}/s{study_id}.txt
    """
    logger.info("Preparing MIMIC-CXR ...")
    split_csv = jpg_dir / "mimic-cxr-2.0.0-split.csv"
    metadata_csv = jpg_dir / "mimic-cxr-2.0.0-metadata.csv"

    for path, label in [(split_csv, "split CSV"), (metadata_csv, "metadata CSV")]:
        if not path.exists():
            logger.error("%s not found: %s", label, path)
            sys.exit(1)

    logger.info("  Reading metadata CSV ...")
    dicom_meta: dict[str, dict] = {}
    with open(metadata_csv, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            dicom_meta[row["dicom_id"]] = row

    logger.info("  Reading split CSV ...")
    split_entries: dict[str, list[tuple[str, str, str]]] = defaultdict(list)
    with open(split_csv, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            split_name = row["split"]
            if split_name == "validate":
                split_name = "validation"
            split_entries[split_name].append(
                (row["subject_id"], row["study_id"], row["dicom_id"])
            )

    prompt_idx = 0
    counts: dict[str, int] = {}

    for split, entries in split_entries.items():
        logger.info("  Processing MIMIC-CXR/%s (%d dicoms) ...", split, len(entries))

        studies: dict[tuple[str, str], list[str]] = defaultdict(list)
        for subj, study, dicom in entries:
            studies[(subj, study)].append(dicom)

        records = []
        for (subj_id, study_id), dicom_ids in tqdm(
            studies.items(), desc=f"MIMIC-CXR/{split}"
        ):
            best_dicom = dicom_ids[0]
            for did in dicom_ids:
                vp = dicom_meta.get(did, {}).get("ViewPosition", "").upper()
                if vp in ("AP", "PA"):
                    best_dicom = did
                    break

            group = f"p{subj_id[:2]}"
            img_path = (
                jpg_dir
                / "files"
                / group
                / f"p{subj_id}"
                / f"s{study_id}"
                / f"{best_dicom}.jpg"
            )
            if not img_path.exists():
                continue

            report_path = reports_dir / group / f"p{subj_id}" / f"s{study_id}.txt"
            report_text = _parse_mimic_report(report_path)
            if not report_text:
                continue

            prompt = MIMIC_PROMPTS[prompt_idx % len(MIMIC_PROMPTS)]
            prompt_idx += 1

            records.append(make_entry(str(img_path.resolve()), prompt, report_text))

        jsonl_path = output_dir / "mimic-cxr" / f"{split}.jsonl"
        write_jsonl(records, jsonl_path)
        counts[split] = len(records)
        logger.info(
            "  MIMIC-CXR/%s: %d examples -> %s", split, len(records), jsonl_path
        )

    return counts


# ---------------------------------------------------------------------------
# Merge training splits
# ---------------------------------------------------------------------------


def merge_train_splits(output_dir: Path, dataset_names: list[str]) -> int:
    """Concatenate every ``train.jsonl`` into ``combined_train.jsonl``."""
    out_path = output_dir / "combined_train.jsonl"
    total = 0
    with open(out_path, "w", encoding="utf-8") as out_fh:
        for name in dataset_names:
            train_path = output_dir / name / "train.jsonl"
            if not train_path.exists():
                logger.warning("  No train split for %s — skipping.", name)
                continue
            count = 0
            with open(train_path, encoding="utf-8") as in_fh:
                for line in in_fh:
                    stripped = line.strip()
                    if stripped:
                        out_fh.write(stripped + "\n")
                        count += 1
            logger.info("  Merged %s/train.jsonl  (%d entries)", name, count)
            total += count

    logger.info("Combined training set: %d examples -> %s", total, out_path)
    return total


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Download & convert medical VQA datasets to unified JSONL.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    scratch = Path(f"/scratch/{os.environ.get('USER', 'nobody')}")
    default_cache = scratch / ".cache" / "huggingface"

    p.add_argument(
        "--cache-dir",
        type=Path,
        default=default_cache,
        help=(
            "HuggingFace cache directory for downloaded datasets. "
            f"Default: {default_cache}"
        ),
    )
    p.add_argument(
        "--output-dir",
        type=Path,
        default=Path("data"),
        help="Root directory for all output (images + JSONL). Default: data/",
    )
    p.add_argument(
        "--datasets",
        nargs="+",
        default=HF_DATASETS,
        choices=ALL_DATASETS,
        help=(
            "Which datasets to prepare.  Default: all HuggingFace datasets "
            "(pathvqa vqarad pubmedvision).  Add 'mimic-cxr' and supply the "
            "corresponding --mimic-cxr-* flags to include it."
        ),
    )
    p.add_argument(
        "--pubmedvision-images-dir",
        type=Path,
        default=None,
        help=(
            "Root directory containing extracted PubMedVision images "
            "(download images_*.zip from the HF repo and unzip into this "
            "directory).  Required when 'pubmedvision' is in --datasets."
        ),
    )
    p.add_argument(
        "--mimic-cxr-jpg-dir",
        type=Path,
        default=None,
        help=(
            "Root of the MIMIC-CXR-JPG v2.0.0 download (contains "
            "mimic-cxr-2.0.0-split.csv, mimic-cxr-2.0.0-metadata.csv, "
            "and files/)."
        ),
    )
    p.add_argument(
        "--mimic-cxr-reports-dir",
        type=Path,
        default=None,
        help=(
            "Root of the MIMIC-CXR reports files/ directory (contains "
            "p{group}/p{subject_id}/s{study_id}.txt report files)."
        ),
    )
    p.add_argument(
        "--no-merge",
        action="store_true",
        help="Skip creation of the combined_train.jsonl file.",
    )
    return p.parse_args()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    args = parse_args()
    output_dir: Path = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    cache_dir: Path = args.cache_dir.resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HOME", str(cache_dir))
    os.environ.setdefault("HF_DATASETS_CACHE", str(cache_dir / "datasets"))
    os.environ.setdefault("HF_HUB_CACHE", str(cache_dir))
    logger.info("HuggingFace cache: %s", cache_dir)

    requested = args.datasets
    all_counts: dict[str, dict[str, int]] = {}

    if "pubmedvision" in requested:
        if args.pubmedvision_images_dir is None:
            logger.error(
                "PubMedVision requires --pubmedvision-images-dir pointing to "
                "extracted images (images_*.zip from the HF repo)."
            )
            sys.exit(1)

    if "mimic-cxr" in requested:
        if args.mimic_cxr_jpg_dir is None or args.mimic_cxr_reports_dir is None:
            logger.error(
                "MIMIC-CXR requires both --mimic-cxr-jpg-dir and "
                "--mimic-cxr-reports-dir."
            )
            sys.exit(1)

    if "pathvqa" in requested:
        all_counts["pathvqa"] = prepare_pathvqa(output_dir, cache_dir)

    if "vqarad" in requested:
        all_counts["vqarad"] = prepare_vqarad(output_dir, cache_dir)

    if "pubmedvision" in requested:
        all_counts["pubmedvision"] = prepare_pubmedvision(
            output_dir, args.pubmedvision_images_dir, cache_dir
        )

    if "mimic-cxr" in requested:
        all_counts["mimic-cxr"] = prepare_mimic_cxr(
            output_dir, args.mimic_cxr_jpg_dir, args.mimic_cxr_reports_dir
        )

    if not args.no_merge:
        merge_train_splits(output_dir, list(all_counts.keys()))

    # Summary
    logger.info("=" * 60)
    logger.info("SUMMARY")
    logger.info("=" * 60)
    grand_total = 0
    for ds_name, splits in all_counts.items():
        ds_total = sum(splits.values())
        grand_total += ds_total
        split_str = ", ".join(f"{s}={n}" for s, n in splits.items())
        logger.info("  %-12s  %6d  (%s)", ds_name, ds_total, split_str)
    logger.info("  %-12s  %6d", "TOTAL", grand_total)
    logger.info("=" * 60)
    logger.info("Output directory: %s", output_dir)


if __name__ == "__main__":
    main()
