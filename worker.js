export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /*
     * API route
     */
    if (url.pathname === "/api/cricket-matches") {
      return handleCricketAPI(request);
    }

    /*
     * Everything else is served from the static files
     * in the project (index.html, admin.html, stream.html, etc.)
     */
    return env.ASSETS.fetch(request);
  }
};


/* =========================================================
   CRICKET API
   ========================================================= */

async function handleCricketAPI(request) {
  try {
    const url = new URL(request.url);

    const mode =
      url.searchParams.get("mode") || "matches";


    /* =====================================================
       LIVE + RECENT + UPCOMING MATCHES
       ===================================================== */

    if (mode === "matches") {

      const response = await fetch(
        "https://sportscore.com/api/widget/matches/?sport=cricket&limit=50"
      );

      if (!response.ok) {
        throw new Error(
          `SportScore returned HTTP ${response.status}`
        );
      }

      const result = await response.json();

      const matches =
        Array.isArray(result.matches)
          ? result.matches
          : [];

      return json({
        sport: "cricket",
        count: matches.length,
        updated: result.updated || null,
        matches
      });
    }


    /* =====================================================
       UNKNOWN MODE
       ===================================================== */

    return json(
      {
        error: "Unknown mode."
      },
      400
    );

  } catch (error) {

    console.error(
      "Cricketive Worker error:",
      error
    );

    return json(
      {
        error:
          error.message ||
          "Unexpected Worker error."
      },
      500
    );
  }
}


/* =========================================================
   JSON RESPONSE
   ========================================================= */

function json(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        "content-type":
          "application/json",

        "cache-control":
          "public, max-age=15",

        "access-control-allow-origin":
          "*"
      }
    }
  );
}
