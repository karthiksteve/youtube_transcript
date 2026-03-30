from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional


@dataclass(frozen=True)
class TranscriptSegment:
    time: float
    text: str


@dataclass(frozen=True)
class TranscriptDoc:
    video_id: str
    title: str
    channel: str
    description: str
    indexed_at: str
    segments: List[TranscriptSegment]


class TranscriptsDB:
    """
    SQLite persistence layer.

    Stores each transcript as a row:
      video_id (PRIMARY KEY), title, channel, description, indexed_at, segments_json
    """

    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS transcripts (
                  video_id TEXT PRIMARY KEY,
                  title TEXT NOT NULL,
                  channel TEXT NOT NULL,
                  description TEXT NOT NULL,
                  indexed_at TEXT NOT NULL,
                  segments_json TEXT NOT NULL
                )
                """
            )
            conn.commit()

    def get_all(self) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT video_id, title, channel, description, indexed_at, segments_json FROM transcripts"
            ).fetchall()

        docs: List[Dict[str, Any]] = []
        for row in rows:
            segments_raw = json.loads(row["segments_json"])
            segments = [
                {"time": float(s["time"]), "text": str(s["text"])}
                for s in segments_raw
                if s and "time" in s and "text" in s and str(s["text"]).strip()
            ]
            docs.append(
                {
                    "video_id": row["video_id"],
                    "title": row["title"],
                    "channel": row["channel"],
                    "description": row["description"],
                    "indexed_at": row["indexed_at"],
                    "segments": segments,
                    "segment_count": len(segments),
                }
            )
        return docs

    def get_one(self, video_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT video_id, title, channel, description, indexed_at, segments_json FROM transcripts WHERE video_id = ?",
                (video_id,),
            ).fetchone()

        if not row:
            return None

        segments_raw = json.loads(row["segments_json"])
        segments = [
            {"time": float(s["time"]), "text": str(s["text"])}
            for s in segments_raw
            if s and "time" in s and "text" in s and str(s["text"]).strip()
        ]
        return {
            "video_id": row["video_id"],
            "title": row["title"],
            "channel": row["channel"],
            "description": row["description"],
            "indexed_at": row["indexed_at"],
            "segments": segments,
            "segment_count": len(segments),
        }

    def upsert(self, doc: Dict[str, Any]) -> Dict[str, Any]:
        """
        Upsert a transcript document by video_id.
        """
        required = ["video_id", "segments"]
        for k in required:
            if k not in doc:
                raise ValueError(f"Missing required field: {k}")

        video_id = str(doc["video_id"])
        segments = doc.get("segments") or []
        segments_json = json.dumps(segments, ensure_ascii=False)

        indexed_at = str(doc.get("indexed_at") or datetime.now().isoformat())
        title = str(doc.get("title") or f"Video {video_id}")
        channel = str(doc.get("channel") or "Unknown")
        description = str(doc.get("description") or "")

        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO transcripts (video_id, title, channel, description, indexed_at, segments_json)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(video_id) DO UPDATE SET
                  title = excluded.title,
                  channel = excluded.channel,
                  description = excluded.description,
                  indexed_at = excluded.indexed_at,
                  segments_json = excluded.segments_json
                """,
                (video_id, title, channel, description, indexed_at, segments_json),
            )
            conn.commit()

        return self.get_one(video_id) or doc

    def delete(self, video_id: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM transcripts WHERE video_id = ?", (video_id,))
            conn.commit()
            return cur.rowcount > 0

    def get_stats(self) -> Dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT
                  COUNT(*) AS video_count,
                  SUM(CASE WHEN json_valid(segments_json) THEN json_array_length(segments_json) ELSE 0 END) AS total_segments,
                  MAX(indexed_at) AS last_updated
                FROM transcripts
                """
            ).fetchone()

        return {
            "video_count": int(row["video_count"] or 0),
            "total_segments": int(row["total_segments"] or 0),
            "last_updated": str(row["last_updated"] or ""),
        }

