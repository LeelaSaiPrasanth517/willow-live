export default {
  async fetch(request, env) {

    const url = new URL(request.url);

    /*
     * Cricket match API
     */
    if (
      url.pathname === "/api/cricket-matches"
    ) {

      return handleCricketAPI();

    }


    /*
     * Everything else goes to
     * Cloudflare Assets.
     */

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


    /* -----------------------------------------------------
       Check SportScore response
       ----------------------------------------------------- */

    if (!response.ok) {

      const body =
        await response.text();

      throw new Error(
        `SportScore returned HTTP ${response.status}: ${body}`
      );

    }


    /* -----------------------------------------------------
       Parse JSON
       ----------------------------------------------------- */

    const payload =
      await response.json();


    /* -----------------------------------------------------
       Get matches
       ----------------------------------------------------- */

    const matches =
      Array.isArray(
        payload.matches
      )
        ? payload.matches
        : [];


    /* -----------------------------------------------------
       Normalize matches
       
       IMPORTANT:
       We are intentionally exposing the raw SportScore
       status values for debugging.
       ----------------------------------------------------- */

    const normalized =
      matches.map(
        match => ({

          /* ---------------------------------------------
             Teams
             --------------------------------------------- */

          home:
            match.home || "",

          away:
            match.away || "",


          /* ---------------------------------------------
             Team logos
             --------------------------------------------- */

          home_logo:
            match.home_logo || "",

          away_logo:
            match.away_logo || "",


          /* ---------------------------------------------
             Original status
             --------------------------------------------- */

          status:
            match.status || "",

          status_text:
            match.status_text || "",


          /* ---------------------------------------------
             RAW STATUS DEBUG FIELDS
             
             These are temporary and will let us see
             exactly what SportScore is returning.
             --------------------------------------------- */

          raw_status:
            match.status ?? null,

          raw_status_text:
            match.status_text ?? null,


          /* ---------------------------------------------
             Match time
             --------------------------------------------- */

          time:
            match.time || null,


          /* ---------------------------------------------
             Competition
             --------------------------------------------- */

          competition:
            match.competition ||
            "Cricket",

          competition_logo:
            match.competition_logo ||
            "",


          /* ---------------------------------------------
             SportScore match URL
             --------------------------------------------- */

          url:
            match.url || ""

        })
      );


    /* -----------------------------------------------------
       Return Cricketive API response
       ----------------------------------------------------- */

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
