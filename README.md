# YouTube Transcript Search Engine (TF-IDF + Timestamps)

A Flask backend + Chrome (Manifest V3) extension that lets you search YouTube transcripts and jump to exact timestamps. The backend indexes transcripts in **SQLite** and uses a pure-Python **TF-IDF** + **cosine similarity** retrieval model.

## Project Structure

```text
youtube-transcript-search/
├── backend/
│   ├── app.py              # Flask API server (endpoints)
│   ├── indexer.py          # YouTube caption fetcher + metadata + CLI indexing
│   ├── search.py           # TF-IDF search engine (TFIDFIndex)
│   ├── db.py               # SQLite persistence layer
│   └── requirements.txt
├── extension/
│   ├── manifest.json      # Chrome Manifest V3
│   ├── popup.html          # Extension popup UI (2 search modes)
│   ├── popup.js            # Popup logic
│   ├── background.js       # Service worker (handles API calls + badge)
│   ├── content.js          # YouTube page script (extracts captions + seeks)
│   ├── options.html        # Settings page
│   ├── options.js
│   └── style.css
├── frontend/
│   └── index.html          # Standalone web search UI
└── data/
    └── transcripts/        # (optional) existing JSON files from earlier runs
```

The active persistence for this version is SQLite at:

`data/transcripts.sqlite3`

## Backend Setup

1. Open a terminal in the project root.
2. Install dependencies:

```bash
cd backend
pip install -r requirements.txt
```

## Start the Flask Backend

From the `backend/` folder:

```bash
python app.py
```

The API will be available at `http://localhost:5000`.

## Load the Chrome Extension (Brave/Chrome)

1. Open `chrome://extensions/` (or `brave://extensions/`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `extension/` folder inside this repo.

Open a YouTube video (or Shorts) and use the extension popup.

## Index a Video (CLI)

Index a single video into SQLite:

```bash
cd backend
python indexer.py "https://www.youtube.com/watch?v=VIDEO_ID"
```

Optional: supply a YouTube Data API key (for better metadata) via env var:

```bash
set YOUTUBE_API_KEY=YOUR_KEY
python indexer.py "https://www.youtube.com/watch?v=VIDEO_ID"
```

Index a playlist:

```bash
python indexer.py "https://www.youtube.com/playlist?list=PLAYLIST_ID" --playlist --max-videos 50
```

## API Endpoints

All endpoints return JSON and, on error, the format is:

```json
{ "error": "message", "code": "ERROR_CODE" }
```

### Search across all indexed videos

`GET /api/search?q=<query>&channel=<name>&limit=<n>`

Query is required. `channel` is optional. `limit` is optional (default `20`, capped at `50`).

Example:

```bash
curl "http://localhost:5000/api/search?q=machine%20learning&limit=20"
```

Response includes ranked videos with:

- `document_score`
- `segments` (top 10 matching transcript segments per video)
- each segment has `{ time, text, score, context: { before, after } }`

### Get full transcript for one video

`GET /api/video/<video_id>`

Example:

```bash
curl "http://localhost:5000/api/video/dQw4w9WgXcQ"
```

### Search within a single video

`GET /api/video/<video_id>/search?q=<query>`

Example:

```bash
curl "http://localhost:5000/api/video/dQw4w9WgXcQ/search?q=neural"
```

Returns top 10 segments for that video.

### Add (upsert) a transcript

`POST /api/add`

Body:

```json
{
  "video_id": "dQw4w9WgXcQ",
  "title": "Video Title",
  "channel": "Channel Name",
  "description": "Short description...",
  "indexed_at": "2026-03-25T10:00:00",
  "segments": [
    { "time": 0.0, "text": "Welcome to this video" },
    { "time": 4.5, "text": "Today we will cover..." }
  ]
}
```

Example:

```bash
curl -X POST "http://localhost:5000/api/add" ^
  -H "Content-Type: application/json" ^
  -d "{\"video_id\":\"VIDEO_ID\",\"segments\":[{\"time\":0.0,\"text\":\"hello world\"}]}"
```

### Delete a video from the index

`DELETE /api/video/<video_id>`

Example:

```bash
curl -X DELETE "http://localhost:5000/api/video/VIDEO_ID"
```

### Index statistics

`GET /api/stats`

Example:

```bash
curl "http://localhost:5000/api/stats"
```

### Full index rebuild (TF-IDF)

`POST /api/index/rebuild`

Example:

```bash
curl -X POST "http://localhost:5000/api/index/rebuild"
```

## How Retrieval Works (Short)

1. **Tokenization**: lowercase, strip punctuation, remove stopwords, keep tokens length >= 3.
2. **TF-IDF**: compute term weights using document frequency across videos.
3. **Cosine similarity**: rank videos by query-video similarity.
4. **Segment selection**: within each top video, score individual segments and return the best matches with 1 segment of surrounding context.

## Notes / Troubleshooting

- If the database is empty, printout on startup tells you how to index videos.
- Some YouTube videos may not provide captions (or captions may be disabled); the extension/content script will show an error.

