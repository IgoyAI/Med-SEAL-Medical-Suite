"""Detect the language of user text and produce the matching system prompt suffix.

Uses ``langdetect`` for identification, mapping results to one of the 10
Southeast Asian languages supported by Med-SEAL plus English as the default.
"""

from __future__ import annotations

import logging

from langdetect import DetectorFactory, detect_langs

logger = logging.getLogger(__name__)

# Deterministic results across runs.
DetectorFactory.seed = 0

# Minimum confidence to accept a non-English detection.
_CONFIDENCE_THRESHOLD = 0.70

# ISO-639-1 → (native name, English name, prompt suffix)
_SEA_LANGUAGES: dict[str, tuple[str, str, str]] = {
    "id": ("Bahasa Indonesia", "Indonesian", "Jawab dalam Bahasa Indonesia."),
    "ms": ("Bahasa Melayu", "Malay", "Jawab dalam Bahasa Melayu."),
    "th": ("ภาษาไทย", "Thai", "ตอบเป็นภาษาไทย"),
    "vi": ("Tiếng Việt", "Vietnamese", "Trả lời bằng tiếng Việt."),
    "tl": ("Filipino", "Filipino/Tagalog", "Sumagot sa Filipino."),
    "my": ("မြန်မာဘာသာ", "Burmese", "မြန်မာဘာသာဖြင့် ဖြေပါ။"),
    "km": ("ភាសាខ្មែរ", "Khmer", "សូមឆ្លើយជាភាសាខ្មែរ។"),
    "lo": ("ພາສາລາວ", "Lao", "ກະລຸນາຕອບເປັນພາສາລາວ."),
    "jv": ("Basa Jawa", "Javanese", "Wangsulana nganggo Basa Jawa."),
    "su": ("Basa Sunda", "Sundanese", "Jawab dina Basa Sunda."),
}

_ENGLISH_CODE = "en"


def detect_language(text: str) -> tuple[str, str | None]:
    """Return ``(iso_code, prompt_suffix_or_None)``.

    Returns ``("en", None)`` when the text is English or detection confidence
    is too low to commit to a SEA language.
    """
    if not text or not text.strip():
        return _ENGLISH_CODE, None

    try:
        detections = detect_langs(text)
    except Exception:
        logger.debug("langdetect failed, falling back to English", exc_info=True)
        return _ENGLISH_CODE, None

    if not detections:
        return _ENGLISH_CODE, None

    top = detections[0]
    code = str(top.lang)
    confidence = float(top.prob)

    if code in _SEA_LANGUAGES and confidence >= _CONFIDENCE_THRESHOLD:
        _, _, suffix = _SEA_LANGUAGES[code]
        return code, suffix

    return _ENGLISH_CODE, None


def language_name(iso_code: str) -> str:
    """Human-readable language name for an ISO code."""
    if iso_code in _SEA_LANGUAGES:
        return _SEA_LANGUAGES[iso_code][1]
    return "English"
