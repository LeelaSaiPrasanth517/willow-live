export default {
  async fetch(request, env) {

    const url = new URL(request.url);

    if (
      url.pathname === "/api/cricket-matches"
    ) {
      return handleCricketAPI();
    }

    return env.ASSETS.fetch(request);
  }
};

/* =========================================================
   SPORTScore MATCH FEED
   ========================================================= */

async function handleCricketAPI() {

  try {

    const response =
      await fetch(
        "https://sportscore.com/api/widget/matches/?sport=cricket&limit=50",
        {
          cf: {
            cacheTtl: 30,
            cacheEverything: true
          }
        }
      );


    if (!response.ok) {
      const body = await response.text();
      throw new Error(`SportScore returned HTTP ${response.status}: ${body}`);
    }

    const payload = await response.json();
    const matches = Array.isArray(payload.matches) ? payload.matches : [];

    /*
     * Normalize matches.
     */
    const normalized =
      matches.map(
        match => ({

          home: match.home || "",
          away: match.away || "",
          home_logo: match.home_logo || "",
          away_logo: match.away_logo || "",

          /*
           * Hybrid status:
           * 1. SportScore status
           * 2. SportScore status text
           * 3. Start-time fallback (Finished cleanup)
           */
          status:
            normalizeSportScoreStatus(
              match.status,
              match.status_text,
              match.time,
              match.competition
            ),

          status_text: match.status_text || "",
          time: match.time || null,
          competition: match.competition || "Cricket",
          competition_logo: match.competition_logo || "",
          url: match.url || ""

        })
      );


    return json({
      sport: "cricket",
      count: normalized.length,
      updated: payload.updated || null,
      matches: normalized
    });

  } catch (error) {

    console.error("Cricketive Worker error:", error);

    return json(
      {
        error: error.message || "Unable to load cricket matches."
      },
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

  /*
   * SportScore status is the primary signal.
   */
  const value = String(status || "").trim().toLowerCase();
  const text = String(statusText || "").trim().toLowerCase();

  /* =====================================================
     1. EXPLICIT LIVE STATUS
     ===================================================== */
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
    text === "ongoing"
  ) {
    return "Live";
  }

  /* =====================================================
     2. EXPLICIT FINISHED STATUS
     ===================================================== */
  if (
    value === "finished" ||
    value === "ended" ||
    value === "completed" ||
    value === "complete" ||
    value === "ft" ||
    text === "finished" ||
    text === "ended" ||
    text === "completed" ||
    text === "complete"
  ) {
    return "Finished";
  }

  /* =====================================================
     3. START-TIME FALLBACK (Finished Cleanup Only)
     ===================================================== */
  if (matchTime) {
    const start = new Date(matchTime);
    const now = new Date();

    if (!Number.isNaN(start.getTime())) {
      const elapsedMs = now.getTime() - start.getTime();
      const elapsedHours = elapsedMs / (1000 * 60 * 60);

      /*
       * More than 6 hours after the scheduled start.
       * Prevent an old "upcoming" match from staying
       * UPCOMING forever if SportScore hasn't updated it.
       */
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

  /* =====================================================
     4. DEFAULT
     ===================================================== */
  return "Upcoming";
}

/* =========================================================
   JSON RESPONSE
   ========================================================= */

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=10",
        "access-control-allow-origin": "*"
      }
    }
  );
}
