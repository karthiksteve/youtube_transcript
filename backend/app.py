from __future__ import annotations

import os
import json
from datetime import datetime
from typing import Any, Dict, Optional

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

from db import TranscriptsDB
from search import TFIDFIndex
from indexer import get_captions, get_video_metadata, extract_video_id


def json_error(message: str, code: str, http_status: int) -> tuple[Any, int]:
    return jsonify({"error": message, "code": code}), http_status


def now_iso() -> str:
    return datetime.now().isoformat()


BASE_DIR = os.path.dirname(__file__)
DATA_DIR = os.path.join(BASE_DIR, "..", "data")
DB_PATH = os.path.join(DATA_DIR, "transcripts.sqlite3")

STATIC_DIR = os.path.join(BASE_DIR, "..", "frontend")

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="")

# Allow extension and local frontends to call the API.
CORS(app, resources={r"/api/*": {"origins": "*"}})

db = TranscriptsDB(DB_PATH)
index = TFIDFIndex()

last_index_rebuild_at: str = ""
last_change_at: str = ""


# Error handlers must come AFTER app = Flask(...)
@app.errorhandler(404)
def handle_404(_: Any) -> Any:
    return json_error("Not found.", "NOT_FOUND", 404)


@app.errorhandler(500)
def handle_500(_: Any) -> Any:
    return json_error("Internal server error.", "INTERNAL_SERVER_ERROR", 500)


def load_and_build_index() -> None:
    global last_index_rebuild_at
    docs = db.get_all()
    if not docs:
        # Best-effort seed: if the repo already contains transcript JSON files from earlier runs,
        # load them into SQLite so the system works out of the box.
        transcripts_dir = os.path.join(DATA_DIR, "transcripts")
        if os.path.isdir(transcripts_dir):
            seeded = 0
            for name in os.listdir(transcripts_dir):
                if not name.endswith(".json"):
                    continue
                path = os.path.join(transcripts_dir, name)
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        doc = json.load(f)
                    if not isinstance(doc, dict):
                        continue
                    if "video_id" not in doc or "segments" not in doc:
                        continue
                    db.upsert(doc)
                    seeded += 1
                except Exception:
                    continue

            if seeded > 0:
                docs = db.get_all()
                index.build_index(docs)
                last_index_rebuild_at = now_iso()
                print(f"Seeded SQLite from {seeded} transcript JSON files. Vocab size={len(index.vocab)}.")
                return

        print(
            "Database is empty. Index transcripts using `python backend/indexer.py <video_url|video_id>` "
            "or add them via POST /api/add, then rebuild the index."
        )
        last_index_rebuild_at = now_iso()
        index.build_index([])
        return
    index.build_index(docs)
    last_index_rebuild_at = now_iso()
    print(f"Loaded {len(docs)} transcripts. Vocab size={len(index.vocab)}.")


@app.get("/")
def serve_frontend() -> Any:
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/search")
def api_search() -> Any:
    q = (request.args.get("q") or "").strip()
    if not q:
        return json_error('Missing required query param "q".', "MISSING_QUERY", 400)

    channel = request.args.get("channel")
    limit_raw = request.args.get("limit")
    try:
        limit = int(limit_raw) if limit_raw is not None else 20
    except ValueError:
        return json_error('Invalid "limit" parameter. Must be an integer.', "INVALID_LIMIT", 400)

    limit = max(1, min(50, limit))
    try:
        results = index.search(query=q, top_k=limit, channel_filter=channel)
    except Exception as e:
        return json_error(f"Search failed: {e}", "SEARCH_FAILED", 500)

    return jsonify(
        {
            "query": q,
            "channel": channel,
            "total_results": len(results),
            "results": results,
            "timestamp": now_iso(),
        }
    )


@app.get("/api/video/<video_id>")
def api_get_video(video_id: str) -> Any:
    doc = db.get_one(video_id)
    if not doc:
        return json_error("Video not found in index.", "VIDEO_NOT_FOUND", 404)
    return jsonify(doc)


@app.get("/api/video/<video_id>/search")
def api_search_within_video(video_id: str) -> Any:
    q = (request.args.get("q") or "").strip()
    if not q:
        return json_error('Missing required query param "q".', "MISSING_QUERY", 400)

    limit_raw = request.args.get("limit")
    try:
        limit = int(limit_raw) if limit_raw is not None else 10
    except ValueError:
        return json_error('Invalid "limit" parameter. Must be an integer.', "INVALID_LIMIT", 400)

    limit = max(1, min(50, limit))

    try:
        segments = index.search_within_video(video_id=video_id, query=q, top_k_segments=limit)
    except Exception as e:
        return json_error(f"Search within video failed: {e}", "SEARCH_FAILED", 500)

    if video_id not in index.documents:
        return json_error("Video not found in index.", "VIDEO_NOT_FOUND", 404)

    return jsonify({"video_id": video_id, "query": q, "results": segments, "timestamp": now_iso()})


@app.post("/api/add")
def api_add_transcript() -> Any:
    data: Optional[Dict[str, Any]] = request.get_json(silent=True)
    if not data:
        return json_error("Missing JSON body.", "INVALID_BODY", 400)

    if "video_id" not in data or "segments" not in data:
        return json_error('Body must include "video_id" and "segments".', "MISSING_FIELDS", 400)

    video_id = str(data["video_id"])
    segments = data.get("segments")
    if not isinstance(segments, list):
        return json_error('"segments" must be a list.', "INVALID_SEGMENTS", 400)

    normalized_segments = []
    for seg in segments:
        if not isinstance(seg, dict):
            continue
        text = str(seg.get("text") or "").strip()
        if not text:
            continue
        try:
            t = float(seg.get("time") or 0.0)
        except ValueError:
            t = 0.0
        normalized_segments.append({"time": t, "text": text})

    if not normalized_segments:
        return json_error("No valid segments found in request body.", "NO_SEGMENTS", 400)

    doc = {
        "video_id": video_id,
        "title": data.get("title"),
        "channel": data.get("channel"),
        "description": data.get("description"),
        "indexed_at": data.get("indexed_at") or now_iso(),
        "segments": normalized_segments,
    }

    try:
        db.upsert(doc)
        index.upsert_document(doc)
    except Exception as e:
        return json_error(f"Failed to add transcript: {e}", "ADD_FAILED", 500)

    global last_change_at
    last_change_at = now_iso()
    return jsonify({"status": "success", "video_id": video_id, "timestamp": last_change_at})


@app.delete("/api/video/<video_id>")
def api_delete_video(video_id: str) -> Any:
    if video_id not in index.documents:
        return json_error("Video not found in index.", "VIDEO_NOT_FOUND", 404)

    try:
        deleted = db.delete(video_id)
        if not deleted:
            return json_error("Video not found in index.", "VIDEO_NOT_FOUND", 404)
        index.delete_document(video_id)
    except Exception as e:
        return json_error(f"Failed to delete video: {e}", "DELETE_FAILED", 500)

    global last_change_at
    last_change_at = now_iso()
    return jsonify({"status": "success", "video_id": video_id, "timestamp": last_change_at})


@app.get("/api/stats")
def api_stats() -> Any:
    stats = db.get_stats()
    channels = sorted({str(doc.get("channel") or "Unknown") for doc in index.documents.values()})

    return jsonify(
        {
            "video_count": stats["video_count"],
            "total_segments": stats["total_segments"],
            "vocabulary_size": len(index.vocab),
            "last_updated": stats.get("last_updated") or "",
            "last_change_at": last_change_at or "",
            "last_rebuild_time": last_index_rebuild_at or "",
            "channels": channels,
        }
    )


@app.post("/api/index/rebuild")
def api_rebuild_index() -> Any:
    global last_index_rebuild_at, last_change_at
    try:
        docs = db.get_all()
        index.build_index(docs)
        last_index_rebuild_at = now_iso()
        last_change_at = last_index_rebuild_at
        return jsonify(
            {
                "status": "success",
                "total_videos": len(docs),
                "vocabulary_size": len(index.vocab),
                "last_rebuild_time": last_index_rebuild_at,
            }
        )
    except Exception as e:
        return json_error(f"Index rebuild failed: {e}", "REBUILD_FAILED", 500)


# ============ NEW: Dynamic transcript fetching endpoints ============

@app.post("/api/fetch")
def api_fetch_transcript() -> Any:
    """
    Fetch and index a transcript from YouTube for any video.
    
    Request body:
      {"video_url": "https://www.youtube.com/watch?v=VIDEO_ID"}
      or
      {"video_id": "VIDEO_ID"}
    
    This fetches the transcript directly from YouTube and adds it to the index.
    """
    data: Optional[Dict[str, Any]] = request.get_json(silent=True)
    if not data:
        return json_error("Missing JSON body.", "INVALID_BODY", 400)

    video_url_or_id = data.get("video_url") or data.get("video_id") or ""
    if not video_url_or_id:
        return json_error('Body must include "video_url" or "video_id".', "MISSING_VIDEO_ID", 400)

    video_id = extract_video_id(str(video_url_or_id))
    if not video_id:
        return json_error("Could not extract a valid video ID.", "INVALID_VIDEO_ID", 400)

    # Check if already indexed
    existing = db.get_one(video_id)
    if existing:
        return jsonify({
            "status": "already_indexed",
            "video_id": video_id,
            "title": existing.get("title"),
            "segment_count": len(existing.get("segments") or []),
            "segments": existing.get("segments") or [],
            "timestamp": now_iso()
        })

    try:
        # Fetch captions from YouTube
        segments = get_captions(video_id)
        if not segments:
            return json_error(
                f"No captions found for video {video_id}. The video may not have captions enabled.",
                "NO_CAPTIONS",
                404
            )

        # Get video metadata
        metadata = get_video_metadata(video_id)

        doc = {
            "video_id": video_id,
            "title": metadata.get("title") or f"Video {video_id}",
            "channel": metadata.get("channel") or "Unknown",
            "description": metadata.get("description") or "",
            "indexed_at": now_iso(),
            "segments": segments,
        }

        # Save to database and update index
        db.upsert(doc)
        index.upsert_document(doc)

        global last_change_at
        last_change_at = now_iso()

        return jsonify({
            "status": "success",
            "video_id": video_id,
            "title": doc["title"],
            "segment_count": len(segments),
            "segments": segments,
            "timestamp": last_change_at
        })

    except Exception as e:
        return json_error(f"Failed to fetch transcript: {e}", "FETCH_FAILED", 500)


@app.get("/api/fetch/<video_id>")
def api_fetch_get_transcript(video_id: str) -> Any:
    """
    GET endpoint to fetch and index a transcript from YouTube.
    
    This is useful for the Chrome extension to quickly fetch a video's transcript.
    """
    # Check if already indexed
    existing = db.get_one(video_id)
    if existing:
        return jsonify({
            "status": "already_indexed",
            "video_id": video_id,
            "title": existing.get("title"),
            "segment_count": len(existing.get("segments") or []),
            "segments": existing.get("segments") or [],
            "timestamp": now_iso()
        })

    try:
        # Fetch captions from YouTube
        segments = get_captions(video_id)
        if not segments:
            return json_error(
                f"No captions found for video {video_id}.",
                "NO_CAPTIONS",
                404
            )

        # Get video metadata
        metadata = get_video_metadata(video_id)

        doc = {
            "video_id": video_id,
            "title": metadata.get("title") or f"Video {video_id}",
            "channel": metadata.get("channel") or "Unknown",
            "description": metadata.get("description") or "",
            "indexed_at": now_iso(),
            "segments": segments,
        }

        # Save to database and update index
        db.upsert(doc)
        index.upsert_document(doc)

        global last_change_at
        last_change_at = now_iso()

        return jsonify({
            "status": "success",
            "video_id": video_id,
            "title": doc["title"],
            "segment_count": len(segments),
            "segments": segments,
            "timestamp": last_change_at
        })

    except Exception as e:
        return json_error(f"Failed to fetch transcript: {e}", "FETCH_FAILED", 500)


@app.get("/api/search/youtube")
def api_search_youtube() -> Any:
    """
    Search YouTube for videos and return results with transcript availability.
    
    Query params:
      q: search query
      max_results: max number of results (default 10)
    """
    q = (request.args.get("q") or "").strip()
    if not q:
        return json_error('Missing required query param "q".', "MISSING_QUERY", 400)

    max_results_raw = request.args.get("max_results")
    try:
        max_results = int(max_results_raw) if max_results_raw is not None else 10
    except ValueError:
        max_results = 10
    max_results = max(1, min(20, max_results))

    # For now, search within indexed videos only
    # In the future, this could integrate with YouTube Data API
    try:
        results = index.search(query=q, top_k=max_results)
    except Exception as e:
        return json_error(f"Search failed: {e}", "SEARCH_FAILED", 500)

    return jsonify({
        "query": q,
        "total_results": len(results),
        "results": results,
        "timestamp": now_iso()
    })


if __name__ == "__main__":
    load_and_build_index()
    app.run(debug=True, host="0.0.0.0", port=5000)
