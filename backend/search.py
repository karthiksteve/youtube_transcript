from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple


STOP_WORDS = {
    "i",
    "me",
    "my",
    "myself",
    "we",
    "our",
    "ours",
    "ourselves",
    "you",
    "you're",
    "you've",
    "you'll",
    "you'd",
    "your",
    "yours",
    "yourself",
    "yourselves",
    "he",
    "him",
    "his",
    "himself",
    "she",
    "she's",
    "her",
    "hers",
    "herself",
    "it",
    "it's",
    "its",
    "itself",
    "they",
    "them",
    "their",
    "theirs",
    "themselves",
    "what",
    "which",
    "who",
    "whom",
    "this",
    "that",
    "that'll",
    "these",
    "those",
    "am",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "having",
    "do",
    "does",
    "did",
    "doing",
    "a",
    "an",
    "the",
    "and",
    "but",
    "if",
    "or",
    "because",
    "as",
    "until",
    "while",
    "of",
    "at",
    "by",
    "for",
    "with",
    "about",
    "against",
    "between",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "to",
    "from",
    "up",
    "down",
    "in",
    "out",
    "on",
    "off",
    "over",
    "under",
    "again",
    "further",
    "then",
    "once",
    "here",
    "there",
    "when",
    "where",
    "why",
    "how",
    "all",
    "each",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "nor",
    "not",
    "only",
    "own",
    "same",
    "so",
    "than",
    "too",
    "very",
    "s",
    "t",
    "can",
    "will",
    "just",
    "don",
    "don't",
    "should",
    "should've",
    "now",
    "d",
    "ll",
    "m",
    "o",
    "re",
    "ve",
    "y",
    "ain",
    "aren",
    "aren't",
    "couldn",
    "couldn't",
    "didn",
    "didn't",
    "doesn",
    "doesn't",
    "hadn",
    "hadn't",
    "hasn",
    "hasn't",
    "haven",
    "haven't",
    "isn",
    "isn't",
    "ma",
    "mightn",
    "mightn't",
    "mustn't",
    "needn",
    "needn't",
    "shan",
    "shan't",
    "shouldn",
    "shouldn't",
    "wasn",
    "wasn't",
    "weren",
    "weren't",
    "won",
    "won't",
    "wouldn",
    "wouldn't",
}


_TOKEN_RE = re.compile(r"\b[a-z0-9]+\b")


def _sentence_before_after(text: str) -> str:
    """
    Extract a single 'sentence-like' chunk.
    Captions often lack punctuation; if none exists, fall back to trimmed text.
    """
    if not text:
        return ""
    t = " ".join(str(text).split())
    parts = re.split(r"(?<=[.!?])\s+", t)
    if parts:
        return parts[0].strip()
    return t.strip()


class TFIDFIndex:
    def __init__(self) -> None:
        self.documents: Dict[str, Dict[str, Any]] = {}  # video_id -> doc metadata + segments
        self.doc_tf: Dict[str, Dict[str, float]] = {}  # video_id -> term -> tf (normalized)
        self.df: Counter[str] = Counter()
        self.vocab: set[str] = set()
        self.N: int = 0  # number of documents

        self._idf_cache_version: int = 0
        self._idf_cache: Dict[str, float] = {}

    def tokenize(self, text: str) -> List[str]:
        if not text:
            return []
        text = str(text).lower()
        tokens = _TOKEN_RE.findall(text)
        tokens = [t for t in tokens if t not in STOP_WORDS and len(t) >= 3]
        return tokens

    def _compute_tf(self, tokens: List[str]) -> Dict[str, float]:
        if not tokens:
            return {}
        counts = Counter(tokens)
        total = max(1, len(tokens))
        return {term: cnt / total for term, cnt in counts.items()}

    def _compute_idf(self, term: str) -> float:
        """
        idf(term) = log((N + 1)/(df(term) + 1)) + 1
        """
        df = self.df.get(term, 0)
        return math.log((self.N + 1) / (df + 1)) + 1.0

    def _idf(self, term: str) -> float:
        if term not in self.df:
            return 0.0
        if term in self._idf_cache:
            return self._idf_cache[term]
        val = self._compute_idf(term)
        self._idf_cache[term] = val
        return val

    def _invalidate_idf_cache(self) -> None:
        self._idf_cache_version += 1
        self._idf_cache.clear()

    def build_index(self, documents: List[Dict[str, Any]]) -> None:
        self.documents = {}
        self.doc_tf = {}
        self.df = Counter()
        self.vocab = set()
        self.N = 0
        self._invalidate_idf_cache()

        for doc in documents:
            video_id = str(doc["video_id"])
            segments = doc.get("segments") or []

            self.documents[video_id] = {
                "video_id": video_id,
                "title": str(doc.get("title") or f"Video {video_id}"),
                "channel": str(doc.get("channel") or "Unknown"),
                "description": str(doc.get("description") or ""),
                "indexed_at": str(doc.get("indexed_at") or ""),
                "segments": segments,
            }

            full_text = " ".join((s.get("text") or "") for s in segments)
            tokens = self.tokenize(full_text)
            tf = self._compute_tf(tokens)
            self.doc_tf[video_id] = tf

            unique_terms = set(tf.keys())
            for term in unique_terms:
                self.df[term] += 1
            self.vocab |= unique_terms

            self.N += 1

        self._invalidate_idf_cache()

    def upsert_document(self, doc: Dict[str, Any]) -> None:
        video_id = str(doc["video_id"])
        segments = doc.get("segments") or []

        new_full_text = " ".join((s.get("text") or "") for s in segments)
        new_tokens = self.tokenize(new_full_text)
        new_tf = self._compute_tf(new_tokens)
        new_terms_set = set(new_tf.keys())

        if video_id in self.documents:
            old_doc = self.documents[video_id]
            old_tf = self.doc_tf.get(video_id, {})
            old_terms_set = set(old_tf.keys())

            # remove old terms from df
            for term in old_terms_set:
                self.df[term] -= 1
                if self.df[term] <= 0:
                    self.df.pop(term, None)
                    self.vocab.discard(term)

            # df update for new terms
            for term in new_terms_set:
                self.df[term] += 1
            self.vocab |= new_terms_set

            # N stays the same on upsert
        else:
            # brand new doc
            for term in new_terms_set:
                self.df[term] += 1
            self.vocab |= new_terms_set
            self.N += 1

        # store document and tf
        self.documents[video_id] = {
            "video_id": video_id,
            "title": str(doc.get("title") or f"Video {video_id}"),
            "channel": str(doc.get("channel") or "Unknown"),
            "description": str(doc.get("description") or ""),
            "indexed_at": str(doc.get("indexed_at") or ""),
            "segments": segments,
        }
        self.doc_tf[video_id] = new_tf

        # N or df changed; invalidate idf cache
        self._invalidate_idf_cache()

    def delete_document(self, video_id: str) -> None:
        video_id = str(video_id)
        if video_id not in self.documents:
            return

        old_tf = self.doc_tf.get(video_id, {})
        old_terms_set = set(old_tf.keys())

        for term in old_terms_set:
            self.df[term] -= 1
            if self.df[term] <= 0:
                self.df.pop(term, None)
                self.vocab.discard(term)

        self.documents.pop(video_id, None)
        self.doc_tf.pop(video_id, None)
        self.N = max(0, self.N - 1)
        self._invalidate_idf_cache()

    def segment_score(self, query_tokens: List[str], segment_text: str) -> float:
        seg_tokens = self.tokenize(segment_text)
        if not seg_tokens:
            return 0.0

        seg_tf = self._compute_tf(seg_tokens)
        if not seg_tf:
            return 0.0

        query_tf = self._compute_tf(query_tokens)
        if not query_tf:
            return 0.0

        score = 0.0
        for term, qtf in query_tf.items():
            if term not in seg_tf:
                continue
            idf = self._idf(term)
            if idf <= 0.0:
                continue
            score += seg_tf[term] * qtf * idf
        return score

    def _cosine_similarity_query_doc(
        self, query_vector: Dict[str, float], doc_tf: Dict[str, float]
    ) -> float:
        if not query_vector or not doc_tf:
            return 0.0

        # dot product
        dot = 0.0
        for term, q_weight in query_vector.items():
            if term not in doc_tf:
                continue
            idf = self._idf(term)
            if idf <= 0.0:
                continue
            # doc weight = tf_doc * idf
            d_weight = doc_tf[term] * idf
            dot += q_weight * d_weight

        # magnitudes
        q_mag = math.sqrt(sum((w * w) for w in query_vector.values()))
        d_mag_sq = 0.0
        for term, tf in doc_tf.items():
            idf = self._idf(term)
            if idf <= 0.0:
                continue
            d_mag_sq += (tf * idf) ** 2
        d_mag = math.sqrt(d_mag_sq)

        if q_mag == 0.0 or d_mag == 0.0:
            return 0.0
        return dot / (q_mag * d_mag)

    def search(
        self,
        query: str,
        top_k: int = 20,
        channel_filter: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        query_tokens = self.tokenize(query)
        if not query_tokens:
            return []

        query_tf = self._compute_tf(query_tokens)
        if not query_tf:
            return []

        # query vector uses tf * idf
        query_vector: Dict[str, float] = {}
        for term, tf in query_tf.items():
            idf = self._idf(term)
            if idf > 0.0:
                query_vector[term] = tf * idf

        if not query_vector:
            return []

        results: List[Dict[str, Any]] = []

        for video_id, doc in self.documents.items():
            if channel_filter and str(doc.get("channel") or "").lower() != channel_filter.lower():
                continue

            doc_tf = self.doc_tf.get(video_id, {})
            document_score = self._cosine_similarity_query_doc(query_vector, doc_tf)
            if document_score <= 0.0:
                continue

            segments = doc.get("segments") or []
            seg_scored: List[Tuple[float, int, Dict[str, Any]]] = []

            for i, seg in enumerate(segments):
                seg_text = str(seg.get("text") or "")
                score = self.segment_score(query_tokens, seg_text)
                if score <= 0.0:
                    continue

                before = ""
                after = ""
                if i - 1 >= 0:
                    before = _sentence_before_after(str(segments[i - 1].get("text") or ""))
                if i + 1 < len(segments):
                    after = _sentence_before_after(str(segments[i + 1].get("text") or ""))

                seg_scored.append(
                    (
                        score,
                        i,
                        {
                            "time": float(seg.get("time") or 0.0),
                            "text": seg_text,
                            "score": score,
                            "context": {"before": before, "after": after},
                        },
                    )
                )

            seg_scored.sort(key=lambda x: x[0], reverse=True)
            top_segments = [s for _, _, s in seg_scored[:10]]

            if not top_segments:
                continue

            results.append(
                {
                    "video_id": video_id,
                    "title": doc.get("title"),
                    "channel": doc.get("channel"),
                    "url": f"https://www.youtube.com/watch?v={video_id}",
                    "thumbnail": f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg",
                    "document_score": document_score,
                    "indexed_at": doc.get("indexed_at") or "",
                    "total_segments": len(segments),
                    "segments": top_segments,
                }
            )

        results.sort(key=lambda r: r["document_score"], reverse=True)
        return results[: max(1, int(top_k))]

    def search_within_video(self, video_id: str, query: str, top_k_segments: int = 10) -> List[Dict[str, Any]]:
        if video_id not in self.documents:
            return []
        query_tokens = self.tokenize(query)
        if not query_tokens:
            return []
        segments = self.documents[video_id].get("segments") or []
        seg_scored: List[Tuple[float, int, Dict[str, Any]]] = []
        for i, seg in enumerate(segments):
            seg_text = str(seg.get("text") or "")
            score = self.segment_score(query_tokens, seg_text)
            if score <= 0.0:
                continue

            before = ""
            after = ""
            if i - 1 >= 0:
                before = _sentence_before_after(str(segments[i - 1].get("text") or ""))
            if i + 1 < len(segments):
                after = _sentence_before_after(str(segments[i + 1].get("text") or ""))
            seg_scored.append(
                (
                    score,
                    i,
                    {
                        "time": float(seg.get("time") or 0.0),
                        "text": seg_text,
                        "score": score,
                        "context": {"before": before, "after": after},
                    },
                )
            )
        seg_scored.sort(key=lambda x: x[0], reverse=True)
        return [s for _, _, s in seg_scored[:top_k_segments]]

