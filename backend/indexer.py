from __future__ import annotations

import os
import re
import time
import html
import json
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

import requests
from youtube_transcript_api import YouTubeTranscriptApi

from db import TranscriptsDB
from search import TFIDFIndex


DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
DB_PATH = os.path.join(DATA_DIR, "transcripts.sqlite3")


YOUTUBE_WATCH_RE = re.compile(r"[?&]v=([a-zA-Z0-9_-]{11})")
YOUTUBE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{11}$")

# Global transcript API instance
_transcript_api = YouTubeTranscriptApi()


def extract_video_id(url_or_id: str) -> Optional[str]:
    """
    Handle:
      - https://www.youtube.com/watch?v=<id>
      - https://www.youtube.com/shorts/<id>
      - https://www.youtube.com/embed/<id>
      - https://youtu.be/<id>
      - raw <id>
    """
    if not url_or_id:
        return None

    s = str(url_or_id).strip()
    if YOUTUBE_ID_RE.match(s):
        return s

    m = YOUTUBE_WATCH_RE.search(s)
    if m:
        return m.group(1)

    parsed = urlparse(s)
    host = (parsed.hostname or "").lower().replace("www.", "")

    if host in {"youtube.com", "m.youtube.com"}:
        if parsed.path == "/watch":
            v = parse_qs(parsed.query).get("v", [None])[0]
            if v and YOUTUBE_ID_RE.match(v):
                return v
        parts = [p for p in parsed.path.split("/") if p]
        # shorts/<id> or embed/<id> or v/<id>
        if len(parts) >= 2 and parts[0] in {"shorts", "embed", "v"}:
            cand = parts[1]
            if YOUTUBE_ID_RE.match(cand):
                return cand

    if host == "youtu.be":
        parts = [p for p in parsed.path.split("/") if p]
        if parts and YOUTUBE_ID_RE.match(parts[0]):
            return parts[0]

    return None


def _fetch_text(url: str, timeout_s: int = 15) -> str:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    res = requests.get(url, headers=headers, timeout=timeout_s)
    res.raise_for_status()
    return res.text


def get_captions(video_id: str) -> List[Dict[str, Any]]:
    """
    Fetch captions from YouTube using youtube-transcript-api.
    Returns list of segments with 'time' and 'text' keys.
    """
    try:
        transcript = _transcript_api.fetch(video_id)
        
        segments = []
        for snippet in transcript:
            # Clean up the text
            text = snippet.text.replace('\n', ' ').strip()
            text = re.sub(r'\s+', ' ', text)
            text = html.unescape(text)
            
            if text:
                segments.append({
                    "time": float(snippet.start),
                    "text": text
                })
        
        return segments
    except Exception as e:
        print(f"Failed to fetch transcript: {e}")
        return []


def _parse_title_from_html(html_text: str) -> str:
    # Prefer og:title
    m = re.search(r'<meta\s+property="og:title"\s+content="([^"]+)"', html_text)
    if m:
        return m.group(1).replace(" - YouTube", "").strip()
    m2 = re.search(r"<title>(.*?)</title>", html_text, flags=re.IGNORECASE | re.DOTALL)
    if m2:
        title = m2.group(1).strip()
        title = title.replace(" - YouTube", "")
        return re.sub(r"\s+", " ", title)
    return "Unknown"


def _parse_description_from_html(html_text: str) -> str:
    m = re.search(r'<meta\s+name="description"\s+content="([^"]+)"', html_text)
    if m:
        desc = html.unescape(m.group(1)).strip()
        return desc[:1200]
    return ""


def _parse_channel_from_html(html_text: str) -> str:
    # Try common meta tag patterns
    m = re.search(r'<meta\s+name="author"\s+content="([^"]+)"', html_text, flags=re.IGNORECASE)
    if m:
        return html.unescape(m.group(1)).strip()

    m2 = re.search(r'"ownerChannelName"\s*:\s*"([^"]+)"', html_text)
    if m2:
        return html.unescape(m2.group(1)).strip()

    return "Unknown"


def get_video_metadata(video_id: str, api_key: str = "") -> Dict[str, str]:
    """
    If api_key is provided, uses YouTube Data API v3 to fetch title/channel/description.
    Otherwise parses HTML from the watch page.
    """
    if api_key:
        url = (
            "https://www.googleapis.com/youtube/v3/videos"
            f"?id={video_id}&key={api_key}&part=snippet"
        )
        res = requests.get(url, timeout=15)
        res.raise_for_status()
        data = res.json()
        items = data.get("items") or []
        if not items:
            return {"title": f"Video {video_id}", "channel": "Unknown", "description": ""}
        snippet = items[0].get("snippet") or {}
        return {
            "title": snippet.get("title") or f"Video {video_id}",
            "channel": snippet.get("channelTitle") or "Unknown",
            "description": (snippet.get("description") or "")[:2000],
        }

    try:
        watch_html = _fetch_text(f"https://www.youtube.com/watch?v={video_id}")
        title = _parse_title_from_html(watch_html)
        channel = _parse_channel_from_html(watch_html)
        description = _parse_description_from_html(watch_html)
        return {"title": title, "channel": channel, "description": description}
    except Exception:
        return {"title": f"Video {video_id}", "channel": "Unknown", "description": ""}


def index_video(video_url_or_id: str, api_key: str = "") -> Dict[str, Any]:
    """
    Full pipeline: extract ID -> fetch captions -> metadata -> save to DB -> rebuild index.
    """
    video_id = extract_video_id(video_url_or_id)
    if not video_id:
        raise ValueError("Could not extract a valid YouTube video id.")

    segments = get_captions(video_id)
    if not segments:
        raise RuntimeError(f"No captions found for video id {video_id}.")

    metadata = get_video_metadata(video_id, api_key=api_key)

    doc = {
        "video_id": video_id,
        "title": metadata["title"],
        "channel": metadata["channel"],
        "description": metadata["description"],
        "indexed_at": datetime_now_iso(),
        "segments": segments,
    }

    db = TranscriptsDB(DB_PATH)
    db.upsert(doc)

    # Rebuild index (in-memory) in this CLI tool.
    docs = db.get_all()
    idx = TFIDFIndex()
    idx.build_index(docs)

    return doc


def datetime_now_iso() -> str:
    from datetime import datetime

    return datetime.now().isoformat()


def _extract_playlist_id(playlist_url: str) -> Optional[str]:
    parsed = urlparse(playlist_url)
    if parsed.hostname and parsed.hostname.lower().endswith("youtube.com"):
        qs = parse_qs(parsed.query)
        pid = qs.get("list", [None])[0]
        if pid:
            return pid
        parts = [p for p in parsed.path.split("/") if p]
        # /playlist/<id>
        if len(parts) >= 2 and parts[0] == "playlist":
            return parts[1]
    return None


def index_playlist(playlist_url: str, api_key: str, max_videos: int = 50) -> List[Dict[str, Any]]:
    """
    Index all videos in a YouTube playlist using Data API playlistItems.list.
    """
    playlist_id = _extract_playlist_id(playlist_url)
    if not playlist_id:
        raise ValueError("Could not extract playlist id from URL.")

    db = TranscriptsDB(DB_PATH)
    docs_added: List[Dict[str, Any]] = []

    page_token: Optional[str] = None
    remaining = max_videos

    while remaining > 0:
        url = (
            "https://www.googleapis.com/youtube/v3/playlistItems"
            f"?part=snippet&maxResults=50&playlistId={playlist_id}&key={api_key}"
        )
        if page_token:
            url += f"&pageToken={page_token}"

        res = requests.get(url, timeout=20)
        res.raise_for_status()
        payload = res.json()

        items = payload.get("items") or []
        if not items:
            break

        for item in items:
            snippet = item.get("snippet") or {}
            vid = (snippet.get("resourceId") or {}).get("videoId")
            if not vid:
                continue
            try:
                segments = get_captions(vid)
                if not segments:
                    continue
                metadata = get_video_metadata(vid, api_key=api_key)
                doc = {
                    "video_id": vid,
                    "title": metadata["title"],
                    "channel": metadata["channel"],
                    "description": metadata["description"],
                    "indexed_at": datetime_now_iso(),
                    "segments": segments,
                }
                db.upsert(doc)
                docs_added.append(doc)
                remaining -= 1
            except Exception:
                # Skip videos that fail caption fetch/parse.
                continue

            if remaining <= 0:
                break

            time.sleep(0.5)

        page_token = payload.get("nextPageToken")
        if not page_token:
            break

    return docs_added


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Index YouTube captions into SQLite.")
    parser.add_argument("input", nargs="?", help="Video URL/id or playlist URL, or --sample")
    parser.add_argument("--playlist", action="store_true", help="Treat input as playlist URL")
    parser.add_argument("--api-key", default=os.environ.get("YOUTUBE_API_KEY", ""), help="YouTube Data API key (optional)")
    parser.add_argument("--max-videos", type=int, default=50)

    args = parser.parse_args()
    if not args.input:
        raise SystemExit("Usage: python backend/indexer.py <video_url|video_id> [--api-key ...] | python backend/indexer.py <playlist_url> --playlist")

    if args.playlist:
        added = index_playlist(args.input, api_key=args.api_key, max_videos=args.max_videos)
        print(f"Indexed {len(added)} videos into the database.")
    else:
        doc = index_video(args.input, api_key=args.api_key)
        print(f"Indexed: {doc['title']} ({len(doc.get('segments') or [])} segments)")
