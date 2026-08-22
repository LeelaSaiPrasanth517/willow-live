/* =========================================================
   Cricketive Worker v9
   - Status & Live Scores: SportScore API
   - Stream Resolver: Extracts raw .m3u8 / .mp4 from webpages
   - Stream Proxy: Rewrites HLS manifests & bypasses CORS
========================================================= */

const SPORTSCORE_MATCHES_URL =
  "https://sportscore.com/api/widget/matches/?sport=cricket&limit=50&src=cricketive";

const DETAIL_CONCURRENCY = 5;
const MAX_DETAIL_LOOKUPS = 15;
const FEED_STALE_MS = 5 * 60 * 1000;

let lastSuccessfulFeed = null;
let lastSuccessfulFeedAt = 0;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight for all endpoints
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/api/cricket-matches") {
      return handleCricketMatches();
    }

    if (url.pathname === "/api/live-scores") {
      return handleLiveScores(request);
    }

    if (url.pathname === "/api/resolve-stream") {
      return handleResolveStream(request);
    }

    if (url.pathname === "/api/proxy-stream") {
      return handleProxyStream(request);
    }

    return env.ASSETS.fetch(request);
  }
};

/* =========================================================
   CORS HEADERS HELPER
========================================================= */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type, Authorization, X-Requested-With",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range"
  };
}

/* =========================================================
   STREAM RESOLVER ENDPOINT
   Scrapes webpage HTML to extract hidden .m3u8 or .mp4 links
========================================================= */

async function handleResolveStream(request) {
  try {
    const reqUrl = new URL(request.url);
    const targetUrl = reqUrl.searchParams.get("url");

    if (!targetUrl) {
      return json({ error: "Missing 'url' query parameter." }, 400);
    }

    const cleanUrl = targetUrl.trim();

    // 1. If it's already a direct media file, return immediately
    if (/\.(m3u8|mp4|webm|ogg)(\?|#|$)/i.test(cleanUrl)) {
      return json({
        success: true,
        streamUrl: cleanUrl,
        type: cleanUrl.includes(".m3u8") ? "hls" : "video"
      });
    }

    // 2. Fetch the webpage HTML with realistic browser headers
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Referer": cleanUrl
    };

    let response = await fetch(cleanUrl, { headers });
    let html = await response.text();

    // 3. Search HTML for stream URL patterns
    let streamUrl = extractMediaUrl(html, cleanUrl);

    // 4. If not found, check if the page embeds another player iframe
    if (!streamUrl) {
      const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (iframeMatch && iframeMatch[1]) {
        let nestedUrl = iframeMatch[1];
        if (nestedUrl.startsWith("//")) nestedUrl = "https:" + nestedUrl;
        else if (nestedUrl.startsWith("/")) {
          const u = new URL(cleanUrl);
          nestedUrl = u.origin + nestedUrl;
        }

        try {
          const nestedResp = await fetch(nestedUrl, {
            headers: { ...headers, "Referer": cleanUrl }
          });
          const nestedHtml = await nestedResp.text();
          streamUrl = extractMediaUrl(nestedHtml, nestedUrl);
        } catch (e) {
          console.warn("Failed fetching nested iframe:", e);
        }
      }
    }

    if (streamUrl) {
      return json({
        success: true,
        streamUrl: streamUrl,
        type: streamUrl.includes(".m3u8") ? "hls" : "video",
        originalUrl: cleanUrl
      });
    }

    return json({
      success: false,
      message: "No direct video stream could be extracted from this page."
    }, 404);

  } catch (err) {
    return json({ error: err.message || "Failed to resolve stream." }, 500);
  }
}

function extractMediaUrl(content, pageUrl) {
  if (!content) return null;

  // Pattern 1: Direct .m3u8 or .mp4 inside quotes
  const directMatch = content.match(/["'](https?:\\?\/\\?\/[^"'\s<>]+\.(?:m3u8|mp4)[^"'\s<>]*)["']/i);
  if (directMatch && directMatch[1]) {
    return directMatch[1].replace(/\\\//g, "/");
  }

  // Pattern 2: Common player configs (source: "...", file: "...")
  const configMatch = content.match(/(?:source|file|src)\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i);
  if (configMatch && configMatch[1]) {
    let resolved = configMatch[1].replace(/\\\//g, "/");
    if (resolved.startsWith("//")) resolved = "https:" + resolved;
    return resolved;
  }

  // Pattern 3: General unquoted .m3u8 match
  const rawHls = content.match(/(https?:\/\/[^\s"'>\\]+\.m3u8[^\s"'>\\]*)/i);
  if (rawHls && rawHls[1]) {
    return rawHls[1];
  }

  return null;
}

/* =========================================================
   STREAM PROXY ENDPOINT
   Proxies HLS/MP4 streams, rewrites manifests, and solves CORS
========================================================= */

async function handleProxyStream(request) {
  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("url");

  if (!target) {
    return new Response("Missing 'url' query parameter", { status: 400 });
  }

  let targetUrlObj;
  try {
    targetUrlObj = new URL(target);
  } catch {
    return new Response("Invalid URL format", { status: 400 });
  }

  const upstreamReferer = reqUrl.searchParams.get("referer") || (targetUrlObj.origin + "/");

  const forwardHeaders = new Headers();
  forwardHeaders.set(
    "User-Agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );
  forwardHeaders.set("Referer", upstreamReferer);
  forwardHeaders.set("Origin", targetUrlObj.origin);

  if (request.headers.has("Range")) {
    forwardHeaders.set("Range", request.headers.get("Range"));
  }

  const upstreamResp = await fetch(target, { headers: forwardHeaders });
  const contentType = upstreamResp.headers.get("content-type") || "";

  const isM3U8 =
    target.includes(".m3u8") ||
    contentType.includes("application/vnd.apple.mpegurl") ||
    contentType.includes("application/x-mpegurl");

  // If HLS Playlist, rewrite segment lines so all chunks route through this proxy
  if (isM3U8) {
    const manifest = await upstreamResp.text();
    const baseUrl = target.substring(0, target.lastIndexOf("/") + 1);

    const rewrittenManifest = manifest
      .split("\n")
      .map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        // Rewrite encryption keys if present
        if (trimmed.startsWith("#EXT-X-KEY")) {
          return trimmed.replace(/URI=["']([^"']+)["']/g, (m, uri) => {
            const abs = resolveAbsoluteUrl(uri, baseUrl, targetUrlObj.origin);
            return `URI="/api/proxy-stream?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(upstreamReferer)}"`;
          });
        }

        if (trimmed.startsWith("#")) {
          return line;
        }

        // Rewrite segment chunk or sub-manifest URI
        const absUrl = resolveAbsoluteUrl(trimmed, baseUrl, targetUrlObj.origin);
        return `/api/proxy-stream?url=${encodeURIComponent(absUrl)}&referer=${encodeURIComponent(upstreamReferer)}`;
      })
      .join("\n");

    return new Response(rewrittenManifest, {
      status: upstreamResp.status,
      headers: {
        ...corsHeaders(),
        "content-type": "application/vnd.apple.mpegurl",
        "cache-control": "no-cache, no-store"
      }
    });
  }

  // Binary chunk, TS segment, or direct MP4 stream
  const responseHeaders = new Headers(upstreamResp.headers);
  for (const [key, value] of Object.entries(corsHeaders())) {
    responseHeaders.set(key, value);
  }

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers: responseHeaders
  });
}

function resolveAbsoluteUrl(relative, base, origin) {
  if (relative.startsWith("http://") || relative.startsWith("https://")) {
    return relative;
  }
  if (relative.startsWith("/")) {
    return origin + relative;
  }
  return base + relative;
}

/* =========================================================
   FETCH / RESILIENCE
========================================================= */

async function fetchWithRetry(url, options = {}, attempts = 3, timeoutMs = 8000) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      if (response.ok) return response;

      lastError = new Error(`HTTP ${response.status}`);

      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }

    if (attempt < attempts) {
      await new Promise(resolve =>
        setTimeout(resolve, 250 * Math.pow(2, attempt - 1))
      );
    }
  }

  throw lastError || new Error("Request failed.");
}

async function fetchJsonWithRetry(url, options = {}, attempts = 3, timeoutMs = 8000) {
  const response = await fetchWithRetry(url, options, attempts, timeoutMs);
  return response.json();
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );

  return results;
}

/* =========================================================
   MAIN MATCH FEED
========================================================= */

async function handleCricketMatches() {
  try {
    const payload = await fetchJsonWithRetry(
      SPORTSCORE_MATCHES_URL,
      {
        cf: {
          cacheTtl: 60,
          cacheEverything: true
        }
      },
      3,
      8000
    );

    const matches = Array.isArray(payload?.matches) ? payload.matches : [];

    const candidates = matches
      .map((match, index) => ({ match, index, priority: detailPriority(match) }))
      .filter(item => item.priority > 0)
      .sort((a, b) => b.priority - a.priority)
      .slice(0, MAX_DETAIL_LOOKUPS);

    const detailMap = new Map();

    const detailResults = await mapWithConcurrency(
      candidates,
      DETAIL_CONCURRENCY,
      async item => {
        try {
          if (!item.match?.url) return { index: item.index, details: null };
          const details = await getIndividualMatch(item.match.url);
          return { index: item.index, details };
        } catch (error) {
          console.warn("SportScore detail lookup failed:", item.match?.url, error?.message || error);
          return { index: item.index, details: null };
        }
      }
    );

    for (const item of detailResults) {
      if (item?.details) detailMap.set(item.index, item.details);
    }

    const normalized = matches.map((match, index) => {
      const details = detailMap.get(index);
      return normalizeMatch(match, details);
    });

    const result = {
      sport: "cricket",
      count: normalized.length,
      live_count: normalized.filter(m => m.status === "Live").length,
      updated: payload?.updated || new Date().toISOString(),
      matches: normalized,
      stale: false,
      source: "sportscore-api"
    };

    lastSuccessfulFeed = result;
    lastSuccessfulFeedAt = Date.now();

    return json(result);
  } catch (error) {
    console.error("Cricketive match feed error:", error);

    if (
      lastSuccessfulFeed &&
      Date.now() - lastSuccessfulFeedAt <= FEED_STALE_MS
    ) {
      return json({
        ...lastSuccessfulFeed,
        stale: true,
        stale_reason: "SportScore temporarily unavailable; showing the last successful feed."
      });
    }

    return json(
      {
        error: error?.message || "Unable to load cricket matches.",
        source: "sportscore-api"
      },
      503
    );
  }
}

function normalizeMatch(match, details) {
  const base = isObject(match) ? match : {};
  const detail = isObject(details) ? details : {};

  const providerStatus = getProviderStatus(base);
  const statusText = getProviderStatusText(base) ?? "";
  const resolvedStatus = normalizeSportScoreStatus(
    providerStatus,
    statusText,
    base.time ?? detail.time ?? null,
    true
  );

  const home = cleanTeamName(base.home ?? detail.home);
  const away = cleanTeamName(base.away ?? detail.away);

  let homeScore = extractTeamScore(base, { home, away }, "home");
  let awayScore = extractTeamScore(base, { home, away }, "away");

  if (!isRealScore(homeScore)) {
    homeScore = extractTeamScore(detail, { home, away }, "home");
  }
  if (!isRealScore(awayScore)) {
    awayScore = extractTeamScore(detail, { home, away }, "away");
  }

  const battingTeam =
    extractBattingTeam(detail) ||
    extractBattingTeam(base) ||
    null;

  const overs =
    extractMatchOvers(detail) ??
    extractMatchOvers(base);

  return {
    home,
    away,
    home_logo: base.home_logo || detail.home_logo || "",
    away_logo: base.away_logo || detail.away_logo || "",
    home_score: homeScore,
    away_score: awayScore,
    status: resolvedStatus.status,
    status_confidence: resolvedStatus.confidence,
    status_text: statusText,
    batting_team: battingTeam,
    overs,
    time: base.time ?? detail.time ?? null,
    competition: base.competition || detail.competition || "Cricket",
    competition_logo:
      base.competition_logo || detail.competition_logo || "",
    url: base.url || detail.url || "",
    score: base.score || base.scores || detail.score || detail.scores || null,
    live_minute: base.live_minute || detail.live_minute || null
  };
}

/* =========================================================
   DETAIL CANDIDATES
========================================================= */

function detailPriority(match) {
  if (!match || !match.url) return 0;

  const status = getProviderStatus(match);
  const statusText = getProviderStatusText(match) || "";

  if (isExplicitFinishedStatus(status, statusText)) return 0;
  if (isExplicitLiveStatus(status, statusText)) return 100;

  const normalizedText = normalizeStatusValue(statusText);
  if (
    normalizedText.includes("1st_inn") ||
    normalizedText.includes("2nd_inn") ||
    normalizedText.includes("innings") ||
    normalizedText.includes("batting") ||
    normalizedText === "live" ||
    normalizedText === "started" ||
    normalizedText === "in_progress" ||
    normalizedText === "inplay" ||
    normalizedText === "in_play"
  ) {
    return 90;
  }

  const start = getMatchStartTime(match.time || match.start_time || match.match_time);
  if (Number.isFinite(start)) {
    const delta = Date.now() - start;
    if (delta >= -30 * 60 * 1000 && delta <= 3 * 60 * 60 * 1000) {
      return 60;
    }
  }

  return 0;
}

/* =========================================================
   INDIVIDUAL SPORTScore MATCH
========================================================= */

async function getIndividualMatch(matchUrl) {
  const slug = extractSlug(matchUrl);
  if (!slug) throw new Error("Could not extract SportScore match slug.");

  const apiUrl =
    "https://sportscore.com/api/widget/match/" +
    `?sport=cricket&slug=${encodeURIComponent(slug)}&src=cricketive`;

  const payload = await fetchJsonWithRetry(
    apiUrl,
    {
      cf: {
        cacheTtl: 60,
        cacheEverything: true
      }
    },
    2,
    7000
  );

  if (payload?.match && isObject(payload.match)) return payload.match;
  if (payload?.data?.match && isObject(payload.data.match)) return payload.data.match;
  if (payload?.data && isObject(payload.data)) return payload.data;
  if (payload && isObject(payload)) return payload;

  return null;
}

function extractSlug(value) {
  if (!value) return null;
  let url = String(value).trim().split("?")[0].replace(/\/+$/, "");
  const parts = url.split("/");
  const slug = parts[parts.length - 1];
  return slug && slug !== "match" ? slug : null;
}

/* =========================================================
   STATUS HELPERS
========================================================= */

function getProviderStatus(obj) {
  if (!isObject(obj)) return null;
  const values = [obj.status, obj.state, obj.match_status, obj.matchStatus, obj.live_status, obj.liveStatus];
  for (const value of values) {
    if (typeof value === "boolean") return value ? "live" : "scheduled";
    if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
  }
  return null;
}

function getProviderStatusText(obj) {
  if (!isObject(obj)) return null;
  const values = [obj.status_text, obj.statusText, obj.match_status_text, obj.matchStatusText, obj.state_text, obj.stateText];
  for (const value of values) {
    if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
  }
  return null;
}

function normalizeStatusValue(value) {
  return String(value || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function isExplicitFinishedStatus(status, statusText = "") {
  const value = normalizeStatusValue(status);
  const text = normalizeStatusValue(statusText);
  return [
    "finished", "finish", "ended", "end", "completed", "complete", "ft", "full_time", "fulltime", "after_match"
  ].includes(value) || [
    "finished", "ended", "completed", "complete"
  ].includes(text) ||
    text.includes("match_finished") || text.includes("match_ended") || text.includes("won_by");
}

function isExplicitLiveStatus(status, statusText = "") {
  const value = normalizeStatusValue(status);
  const text = normalizeStatusValue(statusText);
  return [
    "live", "in_progress", "started", "playing", "ongoing", "inplay", "in_play", "1st_inn", "2nd_inn"
  ].includes(value) || [
    "live", "in_progress", "started", "playing", "ongoing", "inplay", "in_play", "1st_inn", "2nd_inn"
  ].includes(text);
}

function isExplicitNonLiveStatus(status, statusText = "") {
  const value = normalizeStatusValue(status);
  const text = normalizeStatusValue(statusText);
  return [
    "scheduled", "upcoming", "not_started", "notstarted", "pre_match", "prematch", "postponed", "delayed", "cancelled", "canceled", "abandoned"
  ].includes(value) || [
    "scheduled", "upcoming", "not_started", "notstarted", "pre_match", "prematch", "postponed", "delayed", "cancelled", "canceled", "abandoned"
  ].includes(text);
}

function normalizeSportScoreStatus(status, statusText = "", matchTime = null, withConfidence = false) {
  const start = getMatchStartTime(matchTime);
  const result = (value, confidence) => withConfidence ? { status: value, confidence } : value;

  if (Number.isFinite(start) && start > Date.now()) return result("Upcoming", "confirmed");
  if (isExplicitFinishedStatus(status, statusText)) return result("Finished", "confirmed");
  if (isStrongLiveStatus(status, statusText)) return result("Live", "confirmed");

  if (Number.isFinite(start) && start <= Date.now()) {
    return result("Unknown", "inferred");
  }

  if (isExplicitNonLiveStatus(status, statusText)) return result("Upcoming", "confirmed");
  return result("Upcoming", "unknown");
}

function isStrongLiveStatus(status, statusText = "") {
  const value = normalizeStatusValue(status);
  const text = normalizeStatusValue(statusText);
  return (
    ["live", "in_progress", "inplay", "in_play"].includes(value) ||
    ["live", "in_progress", "inplay", "in_play"].includes(text)
  );
}

function getMatchStartTime(value) {
  if (!value) return NaN;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : NaN;
}

/* =========================================================
   SCORE EXTRACTION
========================================================= */

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanTeamName(value) {
  return String(value || "").trim();
}

function normalizeTeamText(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function isScoreString(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return /^\d+(?:\/\d+)?(?:\s*\([^)]*\))?$/.test(text) || /\b\d+\/\d+\b/.test(text);
}

function scoreObjectToText(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return isScoreString(text) ? text.match(/\b\d+(?:\/\d+)(?:\s*\([^)]*\))?\b/)?.[0] || text : null;
  }
  if (!isObject(value)) return null;

  const runs = value.runs ?? value.run ?? value.total_runs ?? value.total ?? value.points ?? null;
  const wickets = value.wickets ?? value.wicket ?? value.outs ?? value.dismissals ?? null;

  if (runs !== null && runs !== undefined && runs !== "") {
    const r = String(runs).trim();
    if (isScoreString(r) && wickets === null) return r;
    if (/^\d+$/.test(r)) {
      if (wickets !== null && wickets !== undefined && /^\d+$/.test(String(wickets).trim())) {
        return `${r}/${String(wickets).trim()}`;
      }
      return r;
    }
  }

  if (value.score !== undefined) {
    const nested = scoreObjectToText(value.score);
    if (nested) return nested;
  }
  return null;
}

function getObjectValue(obj, keys) {
  if (!isObject(obj)) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key];
      if (value !== null && value !== undefined && value !== "") return value;
    }
  }
  return undefined;
}

function teamLooksLike(item, teamName) {
  if (!isObject(item) || !teamName) return false;
  const target = normalizeTeamText(teamName);
  if (!target) return false;

  const candidates = [
    item.team, item.team_name, item.teamName, item.name, item.batting_team, item.batting, item.side, item.label, item.title
  ];

  return candidates.some(value => {
    const normalized = normalizeTeamText(value);
    return normalized && (normalized === target || normalized.includes(target) || target.includes(normalized));
  });
}

function deepFindTeamScore(container, teamName, depth = 0) {
  if (!container || depth > 6) return null;
  if (Array.isArray(container)) {
    for (const item of container) {
      const result = deepFindTeamScore(item, teamName, depth + 1);
      if (result) return result;
    }
    return null;
  }
  if (!isObject(container)) return null;

  if (teamLooksLike(container, teamName)) {
    const direct = scoreObjectToText(container.score ?? container.runs ?? container.total ?? container.scorecard);
    if (direct) return direct;
  }

  for (const [key, value] of Object.entries(container)) {
    if (["home", "away", "home_team", "away_team"].includes(key)) continue;
    if (value && typeof value === "object") {
      const result = deepFindTeamScore(value, teamName, depth + 1);
      if (result) return result;
    }
  }
  return null;
}

function findScoreInInnings(container, teamName, side) {
  if (!container || typeof container !== "object") return null;
  const arrays = [container.innings, container.innings_data, container.inningsData, container.scorecard, container.scores];
  for (const array of arrays) {
    if (!Array.isArray(array)) continue;
    for (const inning of array) {
      if (teamLooksLike(inning, teamName)) {
        const score = scoreObjectToText(inning);
        if (score) return score;
      }
    }
  }
  return deepFindTeamScore(container, teamName);
}

function extractTeamScore(container, match, side) {
  if (!container || typeof container !== "object") return null;
  const teamName = side === "home" ? match?.home || "" : match?.away || "";
  const directKeys = side === "home"
    ? ["home_score", "homeScore", "home_scorecard"]
    : ["away_score", "awayScore", "away_scorecard"];

  const direct = getObjectValue(container, directKeys);
  const directScore = scoreObjectToText(direct);
  if (directScore) return directScore;

  for (const wrapperKey of ["score", "scores", "result", "scoreboard", "live_score", "liveScore"]) {
    const wrapper = container[wrapperKey];
    if (!wrapper || typeof wrapper !== "object") continue;
    const sideKeys = side === "home"
      ? ["home", "home_score", "homeScore", "team1", "team_1"]
      : ["away", "away_score", "awayScore", "team2", "team_2"];

    const value = getObjectValue(wrapper, sideKeys);
    const score = scoreObjectToText(value);
    if (score) return score;

    const inningsScore = findScoreInInnings(wrapper, teamName, side);
    if (inningsScore) return inningsScore;
  }

  const teamObject = container[side];
  const teamScore = scoreObjectToText(teamObject);
  if (teamScore) return teamScore;

  if (teamObject && typeof teamObject === "object") {
    const nested = scoreObjectToText(teamObject.score);
    if (nested) return nested;
  }

  return findScoreInInnings(container, teamName, side);
}

function extractBattingTeam(container) {
  if (!container || typeof container !== "object") return null;
  const direct = getObjectValue(container, ["batting_team", "battingTeam", "current_batting_team"]);
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (direct && typeof direct === "object") {
    return getObjectValue(direct, ["name", "team", "title"]) || null;
  }

  for (const wrapperKey of ["score", "scores", "result", "scoreboard", "live_score", "liveScore"]) {
    const wrapper = container[wrapperKey];
    if (!wrapper || typeof wrapper !== "object") continue;
    const value = getObjectValue(wrapper, ["batting_team", "battingTeam", "batting"]);
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const name = getObjectValue(value, ["name", "team", "title"]);
      if (name) return String(name);
    }
  }
  return null;
}

function extractMatchOvers(container) {
  if (!container || typeof container !== "object") return null;
  const direct = getObjectValue(container, ["overs", "current_overs", "currentOvers"]);
  const directOvers = extractOvers(direct);
  if (directOvers !== null) return directOvers;

  for (const wrapperKey of ["score", "scores", "result", "scoreboard", "live_score", "liveScore"]) {
    const wrapper = container[wrapperKey];
    if (!wrapper || typeof wrapper !== "object") continue;
    const value = getObjectValue(wrapper, ["overs", "current_overs", "currentOvers"]);
    const overs = extractOvers(value);
    if (overs !== null) return overs;
  }
  return null;
}

function isRealScore(value) {
  if (value === null || value === undefined || value === "" || value === "-" || value === "—") return false;
  return isScoreString(value);
}

function extractOvers(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object") return value.current ?? value.total ?? value.overs ?? null;
  return null;
}

/* =========================================================
   LIVE SCORES ENDPOINT
========================================================= */

async function handleLiveScores(request) {
  try {
    const requestUrl = new URL(request.url);
    const requestedSource = requestUrl.searchParams.get("url") || "";

    const payload = await fetchJsonWithRetry(
      SPORTSCORE_MATCHES_URL,
      {
        cf: {
          cacheTtl: 60,
          cacheEverything: true
        }
      },
      3,
      8000
    );

    const matches = Array.isArray(payload?.matches) ? payload.matches : [];

    if (requestedSource) {
      const normalizedRequested = normalizeUrl(requestedSource);
      const source = matches.find(match => normalizeUrl(match.url) === normalizedRequested);

      if (!source) {
        return json({ score: null, error: "Match not found in the current SportScore feed.", updated: new Date().toISOString() });
      }

      const listStatus = getProviderStatus(source);
      const listStatusText = getProviderStatusText(source) || "";

      try {
        const details = await getIndividualMatch(source.url);
        const status = normalizeSportScoreStatus(listStatus, listStatusText, source.time);

        return json({
          score: {
            home: cleanTeamName(source.home || details?.home),
            away: cleanTeamName(source.away || details?.away),
            home_score: extractTeamScore(source, source, "home") || extractTeamScore(details, source, "home"),
            away_score: extractTeamScore(source, source, "away") || extractTeamScore(details, source, "away"),
            status,
            status_text: listStatusText,
            batting_team: extractBattingTeam(details) || extractBattingTeam(source),
            overs: extractMatchOvers(details) ?? extractMatchOvers(source),
            time: source.time || details?.time || null
          },
          updated: new Date().toISOString()
        });
      } catch (error) {
        return json({
          score: {
            home: cleanTeamName(source.home),
            away: cleanTeamName(source.away),
            home_score: extractTeamScore(source, source, "home"),
            away_score: extractTeamScore(source, source, "away"),
            status: normalizeSportScoreStatus(listStatus, listStatusText, source.time, false),
            status_text: listStatusText,
            batting_team: extractBattingTeam(source),
            overs: extractMatchOvers(source),
            time: source.time || null
          },
          stale: true,
          stale_reason: "Individual score endpoint temporarily unavailable.",
          updated: new Date().toISOString()
        });
      }
    }

    const candidates = matches
      .map((match, index) => ({ match, index, priority: detailPriority(match) }))
      .filter(item => item.priority > 0 && isExplicitLiveStatus(getProviderStatus(item.match), getProviderStatusText(item.match)))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, MAX_DETAIL_LOOKUPS);

    const rows = await mapWithConcurrency(candidates, DETAIL_CONCURRENCY, async item => {
      try {
        const details = await getIndividualMatch(item.match.url);
        const status = normalizeSportScoreStatus(
          getProviderStatus(item.match),
          getProviderStatusText(item.match) ?? "",
          item.match.time
        );
        if (status !== "Live") return null;

        return {
          key: normalizeUrl(item.match.url),
          score: {
            home: cleanTeamName(item.match.home || details?.home),
            away: cleanTeamName(item.match.away || details?.away),
            home_score: extractTeamScore(item.match, item.match, "home") || extractTeamScore(details, item.match, "home"),
            away_score: extractTeamScore(item.match, item.match, "away") || extractTeamScore(details, item.match, "away"),
            status,
            status_text: getProviderStatusText(item.match) ?? "",
            batting_team: extractBattingTeam(details) || extractBattingTeam(item.match),
            overs: extractMatchOvers(details) ?? extractMatchOvers(item.match),
            time: item.match.time || details?.time || null
          }
        };
      } catch (error) {
        console.warn("Live score lookup failed:", item.match.url, error?.message || error);
        return null;
      }
    });

    const scores = {};
    for (const row of rows) {
      if (row?.key) scores[row.key] = row.score;
    }

    return json({ scores, updated: new Date().toISOString() });
  } catch (error) {
    return json({ scores: {}, error: error?.message || "Live score request failed.", updated: new Date().toISOString() }, 200);
  }
}

function normalizeUrl(value) {
  if (!value) return "";
  const url = String(value).trim();
  if (url.startsWith("http")) return url.replace(/\/+$/, "");
  return ("https://sportscore.com" + (url.startsWith("/") ? url : `/${url}`)).replace(/\/+$/, "");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=5"
    }
  });
}
