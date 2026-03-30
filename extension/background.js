const DEFAULT_API_BASE = "http://localhost:5000";

async function getApiBase() {
  const { apiBase } = await chrome.storage.sync.get({ apiBase: DEFAULT_API_BASE });
  let base = typeof apiBase === "string" ? apiBase.trim() : DEFAULT_API_BASE;
  if (!base) base = DEFAULT_API_BASE;
  return base.replace(/\/$/, "");
}

async function apiUrl(path) {
  const base = await getApiBase();
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

async function pingStats() {
  const url = await apiUrl("/api/stats");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data;
}

async function updateBadge() {
  try {
    const stats = await pingStats();
    const count = stats.video_count ?? 0;
    chrome.action.setBadgeBackgroundColor({ color: "#2ea44f" });
    chrome.action.setBadgeText({ text: String(count > 99 ? "99+" : count) });
    return { available: true, videoCount: count };
  } catch (e) {
    chrome.action.setBadgeText({ text: "" });
    return { available: false, videoCount: 0 };
  }
}

async function searchAllVideos(query, channel, limit) {
  const url = await apiUrl(`/api/search?q=${encodeURIComponent(query)}` + (channel ? `&channel=${encodeURIComponent(channel)}` : "") + (limit ? `&limit=${encodeURIComponent(limit)}` : ""));
  const res = await fetch(url);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

async function searchVideoSegments(videoId, query, limit) {
  const url = await apiUrl(`/api/video/${encodeURIComponent(videoId)}/search?q=${encodeURIComponent(query)}` + (limit ? `&limit=${encodeURIComponent(limit)}` : ""));
  const res = await fetch(url);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

async function indexVideoDoc(doc) {
  const url = await apiUrl("/api/add");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

setInterval(updateBadge, 60000);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "CHECK_API") {
    updateBadge().then((r) => sendResponse(r));
    return true;
  }

  if (request.action === "SEARCH") {
    searchAllVideos(request.query, request.channel, request.limit)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "SEARCH_VIDEO") {
    searchVideoSegments(request.videoId, request.query, request.limit)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "INDEX_VIDEO") {
    indexVideoDoc(request.doc)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

