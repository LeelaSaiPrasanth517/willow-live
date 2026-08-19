export default async (request) => {
  try {
    const apiKey = process.env.CRICKET_API_KEY;
    if (!apiKey) {
      return json({ error: "CRICKET_API_KEY is not configured in Netlify." }, 500);
    }

    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") || "sync";

    if (mode === "scores") {
      const current = await cricket("currentMatches", 0);
      return json({
        matches: (current.data || []).map(normalizeCurrent)
      });
    }

    if (mode === "sync") {
      // Match List is the schedule source; Current Matches is merged in so
      // matches that are live/current are not missed by the schedule feed.
      const schedule = await cricket("matches", 0);
      const current = await cricket("currentMatches", 0);

      const byId = new Map();

      for (const m of (schedule.data || [])) {
        if (m.id) byId.set(m.id, m);
      }
      for (const m of (current.data || [])) {
        if (!m.id) continue;
        const old = byId.get(m.id) || {};
        byId.set(m.id, { ...old, ...m });
      }

      const now = Date.now();
      const week = now + 8 * 24 * 60 * 60 * 1000;

      const matches = [...byId.values()]
        .map(normalize)
        .filter(m => {
          if (!m.api_match_id || !m.start_time) return false;
          const start = new Date(m.start_time).getTime();
          return (m.match_started && !m.match_ended) ||
                 (start >= now && start <= week);
        })
        .filter(m => !isPlaceholder(m.team1) && !isPlaceholder(m.team2));

      return json({ matches });
    }

    return json({ error: "Unknown mode." }, 400);
  } catch (error) {
    return json({ error: error.message || "Unexpected server error." }, 500);
  }

  async function cricket(endpoint, offset) {
    const apiUrl =
      `https://api.cricapi.com/v1/${endpoint}?apikey=${encodeURIComponent(apiKey)}&offset=${offset}`;
    const response = await fetch(apiUrl);
    if (!response.ok) throw new Error(`Cricket API returned HTTP ${response.status}`);
    const data = await response.json();
    if (data.status !== "success") throw new Error(data.info || `Cricket API ${endpoint} failed.`);
    return data;
  }
};

function normalize(m) {
  const teams = Array.isArray(m.teams) ? m.teams : [];
  const start = m.dateTimeGMT || m.date || null;
  return {
    api_match_id: m.id || null,
    title: m.name || `${teams[0] || ""} vs ${teams[1] || ""}`,
    team1: teams[0] || "",
    team2: teams[1] || "",
    competition: m.matchType || m.series_id || "Cricket",
    venue: m.venue || "",
    start_time: start,
    match_time: start,
    status: m.matchEnded ? "Completed" : (m.matchStarted ? "Live" : "Upcoming"),
    match_started: !!m.matchStarted,
    match_ended: !!m.matchEnded
  };
}

function normalizeCurrent(m) {
  return {
    id: m.id || null,
    name: m.name || "",
    teams: m.teams || [],
    matchStarted: !!m.matchStarted,
    matchEnded: !!m.matchEnded,
    status: m.status || "",
    score: Array.isArray(m.score) ? m.score : [],
    dateTimeGMT: m.dateTimeGMT || null
  };
}

function isPlaceholder(v) {
  return !v || /^tbc$/i.test(String(v).trim()) || /^tbd$/i.test(String(v).trim());
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=60"
    }
  });
}
