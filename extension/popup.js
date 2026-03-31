function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s == null ? "" : String(s);
  return div.innerHTML;
}

function formatTime(seconds) {
  const s = Math.floor(Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const remM = m % 60;
  const remS = s % 60;
  let res = `${remM.toString().padStart(2, "0")}:${remS.toString().padStart(2, "0")}`;
  if (h > 0) res = `${h}:${res}`;
  return res;
}

const STOP_WORDS = new Set([
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
  "she",
  "her",
  "it",
  "its",
  "they",
  "them",
  "their",
  "theirs",
  "what",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
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
  "any",
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
  "can",
  "will",
  "just",
  "don",
  "don't",
  "should",
  "now",
  "d",
  "ll",
  "m",
  "o",
  "re",
  "ve",
  "y",
  "aren",
  "isn",
  "wasn",
  "weren",
  "won",
  "wouldn",
]);

function tokenize(text) {
  const t = String(text || "").toLowerCase();
  const raw = t.match(/\b[a-z0-9]+\b/g) || [];
  return raw.filter((x) => x.length >= 3 && !STOP_WORDS.has(x));
}

function highlightText(text, terms) {
  let html = escapeHtml(text);
  for (const term of terms) {
    if (!term) continue;
    const re = new RegExp(escapeRegex(term), "gi");
    html = html.replace(re, (m) => `<span class="hl">${m}</span>`);
  }
  return html;
}

function sendMessageWithRetry(tabId, message, attempts = 20, delayMs = 250) {
  return new Promise((resolve, reject) => {
    let i = 0;
    const tick = () => {
      chrome.tabs
        .sendMessage(tabId, message)
        .then((res) => {
          if (res) resolve(res);
          else throw new Error("Empty response");
        })
        .catch((e) => {
          i += 1;
          if (i >= attempts) reject(e);
          else setTimeout(tick, delayMs);
        });
    };
    tick();
  });
}

function extractVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();

  // Direct video ID (11 characters)
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;

  // YouTube URLs
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = s.match(pattern);
    if (match) return match[1];
  }

  return null;
}

document.addEventListener("DOMContentLoaded", () => {
  const queryEl = document.getElementById("query");
  const searchBtn = document.getElementById("searchBtn");
  const resultsEl = document.getElementById("results");
  const matchCountEl = document.getElementById("matchCount");
  const fetchRow = document.getElementById("fetchRow");
  const searchRow = document.getElementById("searchRow");
  const quickRow = document.getElementById("quickRow");
  const videoUrlEl = document.getElementById("videoUrl");
  const fetchBtn = document.getElementById("fetchBtn");

  const apiPill = document.getElementById("apiPill");
  const apiDot = document.getElementById("apiDot");
  const apiText = document.getElementById("apiText");

  const tabButtons = document.querySelectorAll(".tab-btn");

  let currentMode = "current";
  let apiAvailable = false;

  let currentTranscript = null;
  let currentVideoId = null;
  let currentVideoTitle = null;

  const quickQueriesByMode = {
    current: ["definition", "example", "algorithm", "advantages", "conclusion"],
    all: ["machine learning", "database", "neural network", "python", "project"],
  };

  function formatScore(score) {
    const n = Number(score);
    if (!Number.isFinite(n) || n <= 0) return "0.000";
    return n.toFixed(3);
  }

  function renderQuickQueries() {
    if (!quickRow) return;
    if (currentMode === "fetch") {
      quickRow.innerHTML = "";
      quickRow.style.display = "none";
      return;
    }

    const queries = quickQueriesByMode[currentMode] || quickQueriesByMode.current;
    quickRow.innerHTML = queries
      .map(
        (q) =>
          `<button class="quick-chip" type="button" data-query="${escapeHtml(q)}">${escapeHtml(q)}</button>`,
      )
      .join("");
    quickRow.style.display = "flex";
  }

  function renderContext(context, terms) {
    if (!context || typeof context !== "object") return "";
    const before = String(context.before || "").trim();
    const after = String(context.after || "").trim();
    let out = "";
    if (before) {
      out += `<div class="context-line"><span class="context-label">Before:</span>${highlightText(before, terms)}</div>`;
    }
    if (after) {
      out += `<div class="context-line"><span class="context-label">After:</span>${highlightText(after, terms)}</div>`;
    }
    return out;
  }

  function setApiStatus(online) {
    apiPill.classList.remove("online", "offline");
    apiPill.classList.add(online ? "online" : "offline");
    if (online) {
      apiText.textContent = "Online";
      apiDot.style.background = "#2ea44f";
    } else {
      apiText.textContent = "Offline";
      apiDot.style.background = "#6e6e6e";
    }
  }

  async function checkApi() {
    try {
      const res = await chrome.runtime.sendMessage({ action: "CHECK_API" });
      apiAvailable = !!res.available;
      setApiStatus(apiAvailable);
    } catch (e) {
      apiAvailable = false;
      setApiStatus(false);
    }
  }

  async function loadCurrent() {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id || !tab?.url) throw new Error("No active tab.");
    if (!String(tab.url).includes("youtube.com"))
      throw new Error("Open a YouTube video page first.");

    const response = await sendMessageWithRetry(tab.id, {
      action: "GET_TRANSCRIPT",
    });
    if (!response || response.error)
      throw new Error(response?.error || "Failed to load transcript.");

    currentTranscript = response.transcript || [];
    currentVideoId = response.videoId || null;
    currentVideoTitle = response.title || null;
  }

  async function indexCurrentVideoToBackend() {
    if (
      !currentVideoId ||
      !Array.isArray(currentTranscript) ||
      currentTranscript.length === 0
    ) {
      throw new Error("Could not read transcript from current video.");
    }

    const doc = {
      video_id: currentVideoId,
      title: currentVideoTitle || `Video ${currentVideoId}`,
      segments: currentTranscript,
    };

    const response = await chrome.runtime.sendMessage({
      action: "INDEX_VIDEO",
      doc,
    });

    if (!response?.success) {
      throw new Error(
        response?.error || "Failed to index current video transcript.",
      );
    }
  }

  async function searchCurrentVideoViaApi(query) {
    if (!apiAvailable)
      throw new Error("Backend offline. Start the Flask server.");

    await loadCurrent();
    if (!currentVideoId)
      throw new Error("Could not detect current YouTube video ID.");

    await indexCurrentVideoToBackend();

    const response = await chrome.runtime.sendMessage({
      action: "SEARCH_VIDEO",
      videoId: currentVideoId,
      query,
      limit: 25,
    });

    if (!response?.success) {
      throw new Error(response?.error || "Search failed.");
    }
    return response.data;
  }

  function localSearch(query) {
    if (!currentTranscript) return [];
    const qTerms = tokenize(query);
    if (!qTerms.length) return [];

    const qLower = String(query || "")
      .toLowerCase()
      .trim();
    const scored = currentTranscript
      .map((seg) => {
        const text = String(seg.text || "");
        const tLower = text.toLowerCase();
        let score = 0;

        if (qLower && tLower.includes(qLower)) score += 20;

        for (const term of qTerms) {
          if (!term) continue;
          const matches = tLower.match(new RegExp(escapeRegex(term), "gi"));
          if (matches) score += matches.length;
        }

        return { segment: seg, score, time: seg.time };
      })
      .filter((x) => x.score > 0);

    scored.sort((a, b) => b.score - a.score || a.time - b.time);
    return scored.slice(0, 25).map((x) => ({ ...x.segment, score: x.score }));
  }

  function renderCurrentResults(results, query) {
    resultsEl.innerHTML = "";
    matchCountEl.textContent = results.length
      ? `${results.length} match(es) in current video`
      : "";

    if (!results.length) {
      resultsEl.innerHTML = '<div class="error">No matches found</div>';
      return;
    }

    const terms = tokenize(query);
    for (const seg of results) {
      const ts = formatTime(seg.time);
      const jumpUrl = currentVideoId
        ? `https://www.youtube.com/watch?v=${currentVideoId}&t=${Math.floor(seg.time)}s`
        : "#";

      const block = document.createElement("div");
      block.className = "result-block";

      block.innerHTML = `
        <div class="seg-top">
          <a href="${escapeHtml(jumpUrl)}" target="_blank" rel="noopener" class="ts" data-jump="${escapeHtml(String(seg.time))}">
            ${escapeHtml(ts)}
          </a>
          <span class="score-pill">Relevance ${escapeHtml(formatScore(seg.score))}</span>
        </div>
        <div class="seg-text">${highlightText(seg.text, terms)}</div>
        ${renderContext(seg.context, terms)}
      `;

      const tsLink = block.querySelector("[data-jump]");
      tsLink.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab?.id) return;
        chrome.tabs
          .sendMessage(tab.id, { action: "JUMP_TO_TIME", time: seg.time })
          .catch(() => {});
      });

      resultsEl.appendChild(block);
    }
  }

  async function searchAll(query) {
    if (!apiAvailable)
      throw new Error("Backend offline. Start the Flask server.");
    const response = await chrome.runtime.sendMessage({
      action: "SEARCH",
      query,
      limit: 20,
    });
    if (!response?.success)
      throw new Error(response?.error || "Search failed.");
    return response.data;
  }

  function renderAllResults(data, query) {
    const results = data.results || [];
    resultsEl.innerHTML = "";
    const terms = tokenize(query);

    matchCountEl.textContent = results.length
      ? `${results.length} video(s) found`
      : "";

    if (!results.length) {
      resultsEl.innerHTML = '<div class="error">No videos found</div>';
      return;
    }

    for (const video of results) {
      const card = document.createElement("div");
      card.className = "video-card";

      const segments = (video.segments || []).slice(0, 3);
      const segHtml = segments
        .map((seg) => {
          const ts = formatTime(seg.time);
          const jumpUrl = `${video.url}&t=${Math.floor(seg.time)}s`;
          return `
            <div class="seg-item">
              <div class="seg-top">
                <div class="ts">${escapeHtml(ts)}</div>
                <span class="score-pill">Seg ${escapeHtml(formatScore(seg.score))}</span>
              </div>
              <div class="seg-text">${highlightText(seg.text, terms)}</div>
              ${renderContext(seg.context, terms)}
              <div class="actions">
                <a class="mini-btn primary" href="${escapeHtml(jumpUrl)}" target="_blank" rel="noopener">Jump</a>
                <button class="mini-btn" type="button" data-copy="${escapeHtml(jumpUrl)}">Copy link</button>
              </div>
            </div>
          `;
        })
        .join("");

      card.innerHTML = `
        <div class="video-row">
          <img class="video-thumb" src="${escapeHtml(video.thumbnail || "")}" alt="" onerror="this.style.display='none'"/>
          <div style="flex:1; min-width:0;">
            <div class="video-title">
              <a href="${escapeHtml(video.url)}" target="_blank" rel="noopener">${escapeHtml(video.title || "")}</a>
            </div>
            <div class="video-meta">Channel: ${escapeHtml(video.channel || "Unknown")} | Score: ${escapeHtml(formatScore(video.document_score))}</div>
            ${segHtml}
          </div>
        </div>
      `;

      card.querySelectorAll("button[data-copy]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const url = btn.getAttribute("data-copy") || "";
          try {
            await navigator.clipboard.writeText(url);
            btn.textContent = "Copied";
            btn.classList.add("copied");
            setTimeout(() => {
              btn.textContent = "Copy link";
              btn.classList.remove("copied");
            }, 1200);
          } catch (e) {
            alert("Copy failed. Copy manually:\n" + url);
          }
        });
      });

      resultsEl.appendChild(card);
    }
  }

  async function fetchVideoTranscript() {
    const urlInput = videoUrlEl.value.trim();
    if (!urlInput) throw new Error("Enter a YouTube URL or video ID.");

    const videoId = extractVideoId(urlInput);
    if (!videoId) throw new Error("Invalid YouTube URL or video ID.");

    resultsEl.innerHTML =
      '<div class="loading">Fetching transcript from YouTube...</div>';
    matchCountEl.textContent = "";

    try {
      const response = await chrome.runtime.sendMessage({
        action: "FETCH_VIDEO",
        videoId,
      });

      if (!response?.success) {
        throw new Error(response?.error || "Failed to fetch transcript.");
      }

      const data = response.data;
      renderFetchResult(data, videoId);
    } catch (e) {
      resultsEl.innerHTML = `<div class="error">${escapeHtml(e.message || String(e))}</div>`;
    }
  }

  function renderFetchResult(data, videoId) {
    resultsEl.innerHTML = "";

    if (!data.segments || data.segments.length === 0) {
      resultsEl.innerHTML =
        '<div class="error">No transcript found for this video.</div>';
      return;
    }

    matchCountEl.textContent = `${data.segments.length} segments fetched`;

    const card = document.createElement("div");
    card.className = "video-card";

    const thumbnail = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const previewSegments = data.segments.slice(0, 5);
    const segHtml = previewSegments
      .map((seg) => {
        const ts = formatTime(seg.time);
        const jumpUrl = `${videoUrl}&t=${Math.floor(seg.time)}s`;
        return `
          <div class="seg-item">
            <div class="seg-top">
              <a href="${escapeHtml(jumpUrl)}" target="_blank" rel="noopener" class="ts">${escapeHtml(ts)}</a>
            </div>
            <div class="seg-text">${escapeHtml(seg.text)}</div>
          </div>
        `;
      })
      .join("");

    card.innerHTML = `
      <div class="video-row">
        <img class="video-thumb" src="${escapeHtml(thumbnail)}" alt="" onerror="this.style.display='none'"/>
        <div style="flex:1; min-width:0;">
          <div class="video-title">
            <a href="${escapeHtml(videoUrl)}" target="_blank" rel="noopener">${escapeHtml(data.title || `Video ${videoId}`)}</a>
          </div>
          <div class="video-meta">${data.segments.length} segments indexed</div>
          <div class="fetch-status success">Transcript indexed successfully! Search this video using "Search all" mode.</div>
          ${segHtml}
        </div>
      </div>
    `;

    resultsEl.appendChild(card);
  }

  async function runSearch() {
    const query = queryEl.value.trim();
    if (!query) return;

    resultsEl.innerHTML = '<div class="loading">Searching…</div>';
    matchCountEl.textContent = "";

    try {
      if (currentMode === "current") {
        const data = await searchCurrentVideoViaApi(query);
        renderCurrentResults(data.results || [], query);
      } else {
        const data = await searchAll(query);
        renderAllResults(data, query);
      }
    } catch (e) {
      resultsEl.innerHTML = `<div class="error">${escapeHtml(e.message || String(e))}</div>`;
    }
  }

  // Tab switching
  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentMode = btn.dataset.mode;

      currentTranscript = null;
      currentVideoId = null;

      queryEl.value = "";
      videoUrlEl.value = "";
      matchCountEl.textContent = "";

      if (currentMode === "fetch") {
        searchRow.style.display = "none";
        fetchRow.style.display = "flex";
        quickRow.style.display = "none";
        resultsEl.innerHTML =
          '<div class="placeholder">Enter a YouTube URL to fetch its transcript.</div>';
      } else {
        searchRow.style.display = "flex";
        fetchRow.style.display = "none";
        renderQuickQueries();
        if (currentMode === "current") {
          resultsEl.innerHTML =
            '<div class="placeholder">Load a transcript to search.</div>';
        } else {
          resultsEl.innerHTML = apiAvailable
            ? '<div class="placeholder">Type to search your indexed library.</div>'
            : '<div class="error">Backend offline. Start the Flask server.</div>';
        }
      }
    });
  });

  searchBtn.addEventListener("click", runSearch);
  queryEl.addEventListener("keypress", (e) => {
    if (e.key === "Enter") runSearch();
  });

  quickRow.addEventListener("click", (e) => {
    const target = e.target.closest("[data-query]");
    if (!target) return;
    queryEl.value = target.getAttribute("data-query") || "";
    runSearch();
  });

  fetchBtn.addEventListener("click", () => fetchVideoTranscript());
  videoUrlEl.addEventListener("keypress", (e) => {
    if (e.key === "Enter") fetchVideoTranscript();
  });

  checkApi();
  renderQuickQueries();

  // initial placeholder
  resultsEl.innerHTML =
    '<div class="placeholder">Type to search in the current video.</div>';
});
