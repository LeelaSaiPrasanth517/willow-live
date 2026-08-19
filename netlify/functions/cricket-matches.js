export default async (request) => {
  try {
    const apiKey = process.env.CRICKET_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "CRICKET_API_KEY is not configured in Netlify." }), {
        status: 500,
        headers: { "content-type": "application/json" }
      });
    }

    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") || "matches";

    if (mode === "scores") {
      const apiUrl = `https://api.cricapi.com/v1/currentMatches?apikey=${encodeURIComponent(apiKey)}&offset=0`;
      const response = await fetch(apiUrl);
      if (!response.ok) throw new Error(`Cricket API returned HTTP ${response.status}`);

      const json = await response.json();
      if (json.status !== "success") {
        throw new Error(json.info || "Cricket score API request failed.");
      }

      const matches = (json.data || []).map(m => ({
        id: m.id || null,
        name: m.name || "",
        teams: m.teams || [],
        matchStarted: !!m.matchStarted,
        matchEnded: !!m.matchEnded,
        status: m.status || "",
        score: Array.isArray(m.score) ? m.score : [],
        dateTimeGMT: m.dateTimeGMT || null
      }));

      return new Response(JSON.stringify({ matches }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=60"
        }
      });
    }

    const now = new Date();
    const from = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    const to = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const all = [];
    const seen = new Set();

    for (let offset = 0; offset <= 250; offset += 25) {
      const apiUrl = `https://api.cricapi.com/v1/matches?apikey=${encodeURIComponent(apiKey)}&offset=${offset}`;
      const response = await fetch(apiUrl);
      if (!response.ok) throw new Error(`Cricket API returned HTTP ${response.status}`);

      const json = await response.json();
      if (json.status !== "success") throw new Error(json.info || "Cricket API request failed.");

      const page = json.data || [];

      for (const match of page) {
        if (!match.id || seen.has(match.id)) continue;
        const start = match.dateTimeGMT ? new Date(match.dateTimeGMT) : null;
        if (!start || Number.isNaN(start.getTime())) continue;

        const relevant =
          (match.matchStarted && !match.matchEnded) ||
          (start >= from && start <= to);

        if (relevant) {
          seen.add(match.id);
          all.push(match);
        }
      }

      const dates = page
        .map(m => m.dateTimeGMT ? new Date(m.dateTimeGMT).getTime() : NaN)
        .filter(Number.isFinite);

      if (!page.length) break;
      if (dates.length && Math.max(...dates) < from.getTime()) break;
    }

    all.sort((a, b) => {
      const aLive = a.matchStarted && !a.matchEnded ? 0 : 1;
      const bLive = b.matchStarted && !b.matchEnded ? 0 : 1;
      if (aLive !== bLive) return aLive - bLive;
      return new Date(a.dateTimeGMT) - new Date(b.dateTimeGMT);
    });

    return new Response(JSON.stringify({ matches: all }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=60"
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || "Unexpected server error." }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  }
};
