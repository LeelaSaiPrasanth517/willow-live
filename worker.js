export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/cricket-matches") {
      return handleCricketAPI();
    }

    return env.ASSETS.fetch(request);
  }
};

/* =========================================================
   SPORTScore DUAL MATCH & LIVE-TICKER FEED
   ========================================================= */

async function handleCricketAPI() {
  try {
    /*
     * Fetch both the full schedule and the real-time live ticker concurrently.
     */
    const [matchesRes, tickerRes] = await Promise.allSettled([
      fetch("https://sportscore.com/api/widget/matches/?sport=cricket&limit=50", {
        cf: { cacheTtl: 30, cacheEverything: true }
      }),
      fetch("https://sportscore.com/api/widget/live-ticker/?sport=cricket", {
        cf: { cacheTtl: 10, cacheEverything: true }
      })
    ]);

    let matches = [];
    let updated = null;

    if (matchesRes.status === "fulfilled" && matchesRes.value.ok) {
      const payload = await matchesRes.value.json();
      matches = Array.isArray(payload.matches) ? payload.matches : [];
      updated = payload.updated || null;
    } else {
      throw new Error("Unable to fetch schedule from SportScore.");
    }

    /*
     * Parse Live Ticker payload into lookup maps
     */
    const tickerByUrl = new Map();
    const tickerByTeams = new Map();

    if (tickerRes.status === "fulfilled" && tickerRes.value.ok) {
      try {
        const tickerPayload = await tickerRes.value.json();
        const tickerMatches = Array.isArray(tickerPayload.matches) ? tickerPayload.matches : [];

        for (const t of tickerMatches) {
          const home = String(t.h || "").trim();
          const away = String(t.a || "").trim();
          const url = String(t.u || "").trim();

          if (url) {
            tickerByUrl.set(normalizeUrl(url), t);
          }
          if (home && away) {
            tickerByTeams.set(makeTeamKey(home, away), t);
          }
        }
      } catch (err) {
        console.warn("Could not parse live ticker payload:", err);
      }
    }

    /*
     * Merge schedule with live ticker scores
     */
    const normalized = matches.map(match => {
      const home = match.home || match.h || "";
      const away = match.away || match.a || "";
      const matchUrl = normalizeUrl(match.url || match.u || "");
      const teamKey = makeTeamKey(home, away);

      // Find real-time score overlay from the ticker
      const ticker = tickerByUrl.get(matchUrl) || tickerByTeams.get(teamKey) || null;

      const rawHomeScore = ticker ? ticker.hs : (match.home_score || match.hs || "");
      const rawAwayScore = ticker ? ticker.as : (match.away_score || match.as || "");
      const rawStatusText = ticker ? ticker.m : (match.status_text || match.m || "");

      return {
        home,
        away,
        home_logo: match.home_logo || match.hl || (ticker ? ticker.hl : ""),
        away_logo: match.away_logo || match.al || (ticker ? ticker.al : ""),

        /* Real-time score data */
        home_score: rawHomeScore,
        away_score: rawAwayScore,

        /* Hybrid status */
        status: normalizeSportScoreStatus(
          match.status,
          rawStatusText,
          match.time,
          match.competition
        ),

        status_text: rawStatusText,
        time: match.time || null,
        competition: match.competition || "Cricket",
        competition_logo: match.competition_logo || "",
        url: match.url || match.u || ""
      };
    });

    return json({
      sport: "cricket",
      count: normalized.length,
      updated: updated || new Date().toISOString(),
      matches: normalized
    });

  } catch (error) {
    console.error("Cricketive Worker error:", error);
    return json(
      { error: error.message || "Unable to load cricket matches." },
      500
    );
  }
}

/* =========================================================
   HYBRID MATCH STATUS
   ========================================================= */

function normalizeSportScoreStatus(
  status,
  statusText = "",
  matchTime = null,
  competition = ""
) {
  const value = String(status || "").trim().toLowerCase();
  const text = String(statusText || "").trim().toLowerCase();

  /* 1. EXPLICIT LIVE STATUS */
  if (
    value === "live" ||
    value === "in_progress" ||
    value === "in progress" ||
    value === "started" ||
    value === "playing" ||
    value === "ongoing" ||
    text === "live" ||
    text === "in progress" ||
    text === "in_progress" ||
    text === "started" ||
    text === "playing" ||
    text === "ongoing" ||
    text.includes("inn") ||
    text.includes("innings") ||
    text.includes("over")
  ) {
    return "Live";
  }

  /* 2. EXPLICIT FINISHED STATUS */
  if (
    value === "finished" ||
    value === "ended" ||
    value === "completed" ||
    value === "complete" ||
    value === "ft" ||
    text === "finished" ||
    text === "ended" ||
    text === "completed" ||
    text === "complete" ||
    text.includes("won by")
  ) {
    return "Finished";
  }

  /* 3. START-TIME FALLBACK (Finished Cleanup Only) */
  if (matchTime) {
    const start = new Date(matchTime);
    const now = new Date();

    if (!Number.isNaN(start.getTime())) {
      const elapsedMs = now.getTime() - start.getTime();
      const elapsedHours = elapsedMs / (1000 * 60 * 60);

      if (
        elapsedHours > 6 &&
        (
          value === "upcoming" ||
          value === "scheduled" ||
          value === "not_started" ||
          value === "not started" ||
          value === ""
        )
      ) {
        return "Finished";
      }
    }
  }

  /* 4. DEFAULT */
  return "Upcoming";
}

/* =========================================================
   HELPERS
   ========================================================= */

function makeTeamKey(team1, team2) {
  if (!team1 || !team2) return "";
  return [String(team1).trim().toLowerCase(), String(team2).trim().toLowerCase()]
    .sort()
    .join("|");
}

function normalizeUrl(value) {
  if (!value) return "";
  const url = String(value).trim();
  if (url.startsWith("http")) return url.replace(/\/+$/, "");
  return ("https://sportscore.com" + (url.startsWith("/") ? url : `/${url}`)).replace(/\/+$/, "");
}

/* =========================================================
   JSON RESPONSE
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
