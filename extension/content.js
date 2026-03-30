// Content script for YouTube Transcript Search Extension (MV3)
// Extracts caption transcript + metadata from the page, then supports:
// - GET_TRANSCRIPT: returns { transcript, videoId, title }
// - JUMP_TO_TIME: seeks the current <video> element

(() => {
  if (window.__ytTranscriptSearchInjected) return;
  window.__ytTranscriptSearchInjected = true;

  let cachedTranscript = null;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "GET_TRANSCRIPT") {
      getTranscript()
        .then((data) => sendResponse(data))
        .catch((err) => sendResponse({ error: err.message || String(err) }));
      return true;
    }

    if (request.action === "JUMP_TO_TIME") {
      try {
        const seconds = Number(request.time) || 0;
        const video = document.querySelector("video");
        if (video) {
          video.currentTime = seconds;
          video.play().catch(() => {});
        }
      } catch (e) {
        // best-effort
      }
    }
  });

  async function getTranscript() {
    if (cachedTranscript && cachedTranscript.transcript) return cachedTranscript;

    const playerResponse = await waitForPlayerResponse(12000, 250);
    if (!playerResponse) {
      throw new Error("Timed out waiting for YouTube player data.");
    }

    const videoId = playerResponse?.videoDetails?.videoId;
    const title =
      playerResponse?.videoDetails?.title || document.title?.replace(/\s+-\s+YouTube\s*$/i, "") || "Unknown";

    const captionTracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!captionTracks || !Array.isArray(captionTracks) || captionTracks.length === 0) {
      throw new Error("No caption tracks found. Turn on subtitles for this video.");
    }

    const track =
      captionTracks.find((t) => t.languageCode && String(t.languageCode).toLowerCase().startsWith("en")) ||
      captionTracks[0];

    if (!track || !track.baseUrl) {
      throw new Error("Could not resolve caption track URL.");
    }

    let baseUrl = String(track.baseUrl);
    baseUrl = baseUrl.replace(/\\u0026/g, "&");

    // Ensure xml3 format.
    if (!/[?&]fmt=/.test(baseUrl)) {
      baseUrl += (baseUrl.includes("?") ? "&" : "?") + "fmt=xml3";
    } else {
      baseUrl = baseUrl.replace(/([?&])fmt=[^&]*/i, "$1fmt=xml3");
    }

    const xmlText = await fetch(baseUrl, { credentials: "omit" }).then((r) => r.text());
    if (!xmlText || !xmlText.includes("<text")) {
      // Some responses are empty/unexpected; throw with a hint.
      throw new Error("Failed to fetch captions XML. Captions may be unavailable for this video.");
    }

    const transcript = parseTranscriptXml(xmlText);
    if (!transcript || transcript.length === 0) {
      throw new Error("Transcript is empty after parsing captions XML.");
    }

    cachedTranscript = { transcript, videoId, title };
    return cachedTranscript;
  }

  async function waitForPlayerResponse(timeoutMs, stepMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;

      const scriptText = extractAssignedJsonFromScripts("ytInitialPlayerResponse");
      if (scriptText) return scriptText;

      await new Promise((r) => setTimeout(r, stepMs));
    }
    return null;
  }

  function extractAssignedJsonFromScripts(varName) {
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const text = script.textContent || "";
      if (!text.includes(varName)) continue;

      const idx = text.indexOf(varName);
      if (idx === -1) continue;

      // Find first '{' after the variable declaration.
      const braceStart = text.indexOf("{", idx);
      if (braceStart === -1) continue;

      const jsonStr = sliceBalanced(text, braceStart, "{", "}");
      if (!jsonStr) continue;

      try {
        return JSON.parse(jsonStr);
      } catch (e) {
        // keep searching
      }
    }
    return null;
  }

  function sliceBalanced(s, startIdx, openCh, closeCh) {
    let depth = 0;
    let inString = false;
    let escape = false;
    const openCode = openCh.charCodeAt(0);
    const closeCode = closeCh.charCodeAt(0);

    for (let i = startIdx; i < s.length; i++) {
      const ch = s[i];
      const code = s.charCodeAt(i);

      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }

      if (ch === "\"") {
        inString = true;
        continue;
      }

      if (code === openCode) depth++;
      else if (code === closeCode) {
        depth--;
        if (depth === 0) return s.substring(startIdx, i + 1);
      }
    }
    return null;
  }

  function parseTranscriptXml(xmlText) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");
    const textNodes = xmlDoc.getElementsByTagName("text");
    const out = [];

    for (let i = 0; i < textNodes.length; i++) {
      const node = textNodes[i];
      const start = parseFloat(node.getAttribute("start") || "0");
      const raw = node.textContent || "";
      const cleaned = raw
        .replace(/\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (cleaned) out.push({ time: start, text: cleaned });
    }

    out.sort((a, b) => a.time - b.time);
    return out;
  }
})();

