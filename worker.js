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
            cacheTtl: 60,
            cacheEverything: true
          }
        }
      );


    if (!response.ok) {

      const body =
        await response.text();

      throw new Error(
        `SportScore returned HTTP ${response.status}: ${body}`
      );

    }


    const payload =
      await response.json();


    const matches =
      Array.isArray(
        payload.matches
      )
        ? payload.matches
        : [];


    /*
     * Return only the fields Cricketive needs.
     *
     * NO SCORE.
     * NO MATCH-DETAIL API.
     */

    const normalized =
      matches.map(
        match => ({

          home:
            match.home || "",

          away:
            match.away || "",

          home_logo:
            match.home_logo || "",

          away_logo:
            match.away_logo || "",

          status:
            match.status || "",

          status_text:
            match.status_text || "",

          time:
            match.time || null,

          competition:
            match.competition ||
            "Cricket",

          competition_logo:
            match.competition_logo ||
            "",

          url:
            match.url || ""

        })
      );


    return json({

      sport:
        "cricket",

      count:
        normalized.length,

      updated:
        payload.updated || null,

      matches:
        normalized

    });


  } catch (error) {

    console.error(
      "Cricketive Worker error:",
      error
    );


    return json(
      {
        error:
          error.message ||
          "Unable to load cricket matches."
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
    JSON.stringify(
      data
    ),
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
