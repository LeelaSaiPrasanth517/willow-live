export default async (request) => {
  try {
    const apiKey = process.env.CRICKET_API_KEY;
    if (!apiKey) return json({ error: "CRICKET_API_KEY is not configured in Netlify." }, 500);

    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") || "sync";

    // eCricScore is designed by Cricket Data to return last 7 days,
    // next 7 days, and current live matches in one response.
    const apiUrl = `https://api.cricapi.com/v1/cricScore?apikey=${encodeURIComponent(apiKey)}`;
    const response = await fetch(apiUrl);
    if (!response.ok) throw new Error(`Cricket API returned HTTP ${response.status}`);

    const payload = await response.json();
    if (payload.status !== "success") throw new Error(payload.info || "Cricket API request failed.");

    const matches = (payload.data || [])
      .map(normalize)
      .filter(Boolean)
      .filter(m => !isPlaceholder(m.team1) && !isPlaceholder(m.team2));

    if (mode === "scores") {
      return json({ matches });
    }

    if (mode === "sync") {
      return json({ matches });
    }

    return json({ error: "Unknown mode." }, 400);
  } catch (error) {
    return json({ error: error.message || "Unexpected server error." }, 500);
  }
};

function normalize(m) {
  const teams = Array.isArray(m.teams) ? m.teams : [];
  const team1 = m.team1 || m.t1 || teams[0] || "";
  const team2 = m.team2 || m.t2 || teams[1] || "";

  // eCricScore has used compact fields in some responses and
  // richer match objects in others, so accept both shapes.
  const start =
    m.dateTimeGMT ||
    m.dateTime ||
    m.start_time ||
    m.date ||
    null;

  const started =
    Boolean(m.matchStarted ?? m.match_started ?? m.live) ||
    /live|in progress|stumps|innings|break/i.test(String(m.status || ""));

  const ended =
    Boolean(m.matchEnded ?? m.match_ended) ||
    /won by|draw|tie|no result|abandoned|match ended|completed/i.test(String(m.status || ""));

  const scores = Array.isArray(m.score) ? m.score : [];

  let status = ended ? "Completed" : (started ? "Live" : "Upcoming");

  return {
    api_match_id: m.id || m.match_id || m.unique_id || null,
    title: m.name || m.title || `${team1} vs ${team2}`,
    team1,
    team2,
    competition: m.seriesName || m.series_name || m.matchType || m.type || "Cricket",
    venue: m.venue || "",
    start_time: start,
    match_time: start,
    status,
    match_started: started,
    match_ended: ended,
    score: scores,
    live_status: m.status || ""
  };
}

function isPlaceholder(v) {
  return !v || /^(tbc|tbd|to be confirmed|to be decided)$/i.test(String(v).trim());
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
