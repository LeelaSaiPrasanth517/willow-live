export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/cricket-matches") {
      return handleCricketAPI();
    }

    if (url.pathname === "/api/live-scores") {
      return handleLiveScores(url);
    }

    return env.ASSETS.fetch(request);
  }
};

/* =========================================================
   SPORTScore MATCH FEED
   ========================================================= */
async function handleCricketAPI() {
  try {
    const response = await fetch(
      "https://sportscore.com/api/widget/matches/?sport=cricket&limit=50",
      { cf: { cacheTtl: 30, cacheEverything: true } }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`SportScore returned HTTP ${response.status}: ${body}`);
    }

    const payload = await response.json();
    const matches = Array.isArray(payload.matches) ? payload.matches : [];

    const normalized = matches.map(match => ({
      home: match.home || "",
      away: match.away || "",
      home_logo: match.home_logo || "",
      away_logo: match.away_logo || "",
      status: normalizeSportScoreStatus(match.status, match.status_text, match.time, match.competition),
      status_text: match.status_text || "",
      time: match.time || null,
      competition: match.competition || "Cricket",
      competition_logo: match.competition_logo || "",
      url: match.url || "",
      score: match.score || null
    }));

    return json({
      sport: "cricket",
      count: normalized.length,
      updated: payload.updated || null,
      matches: normalized
    });
  } catch (error) {
    console.error("Cricketive Worker error:", error);
    return json({ error: error.message || "Unable to load cricket matches." }, 500);
  }
}

/* =========================================================
   LIVE SCORES ENDPOINT (ULTIMATE FIX - NO CRASHES)
   ========================================================= */
async function handleLiveScores(url) {
  try {
    const response = await fetch(
      "https://sportscore.com/api/widget/matches/?sport=cricket&limit=50",
      { cf: { cacheTtl: 10, cacheEverything: true } }
    );

    if (!response.ok) {
      throw new Error(`SportScore returned HTTP ${response.status}`);
    }

    const payload = await response.json();
    const matches = Array.isArray(payload.matches) ? payload.matches : [];

    const scoreMap = {};
    for (const match of matches) {
      const key = match.url ? normalizeUrl(match.url) : null;
      if (!key) continue;

      // --- SAFE EXTRACTION LOGIC ---
      let homeScore = null;
      let awayScore = null;
      let overs = null;

      // 1. Try to get scores safely
      const rawHome = match.home_score ?? match.score?.home ?? null;
      const rawAway = match.away_score ?? match.score?.away ?? null;
      const rawOvers = match.overs ?? match.score?.overs ?? null;

      // 2. If it's an object, extract runs/total. If it's a number/string, use it directly.
      if (rawHome !== null && rawHome !== undefined) {
        homeScore = (typeof rawHome === 'object') ? (rawHome.runs ?? rawHome.total ?? null) : rawHome;
      }
      if (rawAway !== null && rawAway !== undefined) {
        awayScore = (typeof rawAway === 'object') ? (rawAway.runs ?? rawAway.total ?? null) : rawAway;
      }
      if (rawOvers !== null && rawOvers !== undefined) {
        overs = (typeof rawOvers === 'object') ? (rawOvers.current ?? rawOvers.total ?? null) : rawOvers;
      }

      // 3. Store it
      scoreMap[key] = {
        home_score: homeScore,
        away_score: awayScore,
        status: match.status || null,
        status_text: match.status_text || null,
        overs: overs,
        batting_team: match.batting_team || null
      };
    }

    return json({ scores: scoreMap, updated: new Date().toISOString() });
  } catch (error) {
    console.error("Live scores error:", error);
    // Return empty scores instead of crashing so the page still loads
    return json({ scores: {}, error: error.message, updated: new Date().toISOString() }, 200);
  }
}

/* =========================================================
   HYBRID MATCH STATUS
   ========================================================= */
function normalizeSportScoreStatus(status, statusText = "", matchTime = null, competition = "") {
  const value = String(status || "").trim().toLowerCase();
  const text = String(statusText || "").trim().toLowerCase();

  if (value === "live" || value === "in_progress" || value === "in progress" || 
      value === "started" || value === "playing" || value === "ongoing" ||
      text === "live" || text === "in progress" || text === "in_progress" || 
      text === "started" || text === "playing" || text === "ongoing") {
    return "Live";
  }

  if (value === "finished" || value === "ended" || value === "completed" || 
      value === "complete" || value === "ft" ||
      text === "finished" || text === "ended" || text === "completed" || text === "complete") {
    return "Finished";
  }

  if (matchTime) {
    const start = new Date(matchTime);
    const now = new Date();
    if (!Number.isNaN(start.getTime())) {
      const elapsedHours = (now.getTime() - start.getTime()) / (1000 * 60 * 60);
      if (elapsedHours >= 0 && elapsedHours <= 6) {
        return "Live";
      }
      if (elapsedHours > 6 && (value === "upcoming" || value === "scheduled" || 
          value === "not_started" || value === "not started" || value === "")) {
        return "Finished";
      }
    }
  }

  return "Upcoming";
}

/* =========================================================
   URL NORMALIZATION
   ========================================================= */
function normalizeUrl(value) {
  if (!value) return "";
  const url = String(value).trim();
  if (url.startsWith("http")) return url.replace(/\/+$/, "");
  return ("https://sportscore.com" + (url.startsWith("/") ? url : `/${url}`)).replace(/\/+$/, "");
}

/* =========================================================
   JSON RESPONSE HELPER
   ========================================================= */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=10",
      "access-control-allow-origin": "*"
    }
  });
}
