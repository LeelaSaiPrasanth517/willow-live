export default async (request) => {
  try {
    const apiKey = process.env.CRICKET_API_KEY;

    if (!apiKey) {
      return json({ error: "CRICKET_API_KEY is missing." }, 500);
    }

    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") || "matches";

    // Scheduled/current match list
    if (mode === "matches") {
      const apiUrl =
        `https://api.cricapi.com/v1/matches?apikey=${encodeURIComponent(apiKey)}&offset=0`;

      const response = await fetch(apiUrl);

      if (!response.ok) {
        throw new Error(`Cricket API returned HTTP ${response.status}`);
      }

      const result = await response.json();

      if (result.status !== "success") {
        throw new Error(result.info || "Matches API failed.");
      }

      const matches = (result.data || [])
        .map(normalizeMatch)
        .filter(Boolean)
        .filter(m => !isPlaceholder(m.team1) && !isPlaceholder(m.team2));

      return json({ matches });
    }

    // Live score/current matches
    if (mode === "scores") {
      const apiUrl =
        `https://api.cricapi.com/v1/currentMatches?apikey=${encodeURIComponent(apiKey)}&offset=0`;

      const response = await fetch(apiUrl);

      if (!response.ok) {
        throw new Error(`Cricket API returned HTTP ${response.status}`);
      }

      const result = await response.json();

      if (result.status !== "success") {
        throw new Error(result.info || "Current Matches API failed.");
      }

      const matches = (result.data || [])
        .map(m => ({
          id: m.id,
          name: m.name,
          teams: m.teams || [],
          status: m.status || "",
          score: m.score || [],
          matchStarted: !!m.matchStarted,
          matchEnded: !!m.matchEnded,
          dateTimeGMT: m.dateTimeGMT || null
        }))
        .filter(m => m.id);

      return json({ matches });
    }

    return json({ error: "Unknown mode." }, 400);

  } catch (error) {
    return json({
      error: error.message || "Unexpected server error."
    }, 500);
  }
};


function normalizeMatch(m) {
  const teams = Array.isArray(m.teams) ? m.teams : [];

  const team1 = teams[0] || "";
  const team2 = teams[1] || "";

  const startTime =
    m.dateTimeGMT ||
    m.dateTime ||
    null;

  if (!m.id || !team1 || !team2 || !startTime) {
    return null;
  }

  return {
    api_match_id: m.id,
    title: m.name || `${team1} vs ${team2}`,
    team1,
    team2,
    competition: m.seriesName || m.matchType || "Cricket",
    venue: m.venue || "",
    start_time: startTime,
    match_time: startTime,
    status: m.matchEnded
      ? "Finished"
      : m.matchStarted
        ? "Live"
        : "Upcoming"
  };
}


function isPlaceholder(value) {
  if (!value) return true;

  return /^(tbc|tbd|to be confirmed|to be decided)$/i
    .test(String(value).trim());
}


function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=60"
    }
  });
}
