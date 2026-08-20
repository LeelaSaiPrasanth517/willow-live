export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /*
     * =======================================================
     * SPORTScore MATCH FEED
     * =======================================================
     */
    if (url.pathname === "/api/cricket-matches") {
      return handleCricketAPI();
    }

    /*
     * =======================================================
     * LIVE SCORES
     * =======================================================
     */
    if (url.pathname === "/api/live-scores") {
      return handleLiveScores();
    }

    /*
     * =======================================================
     * EVERYTHING ELSE
     * =======================================================
     */
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
      {
        cf: {
          cacheTtl: 10,
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
      Array.isArray(payload.matches)
        ? payload.matches
        : [];


    /*
     * IMPORTANT:
     *
     * We now explicitly pass:
     *
     * home_score
     * away_score
     * status_text
     * batting_team
     * overs
     *
     * to the homepage.
     */

    const normalized =
      matches.map(match => {

        return {

          home:
            match.home ||
            "",


          away:
            match.away ||
            "",


          home_logo:
            match.home_logo ||
            "",


          away_logo:
            match.away_logo ||
            "",


          /*
           * THIS WAS THE MISSING PART
           */

          home_score:
            extractScore(
              match.home_score
            ),


          away_score:
            extractScore(
              match.away_score
            ),


          /*
           * Keep the raw score too,
           * in case the frontend needs it.
           */

          score:
            match.score ||
            null,


          status:
            normalizeSportScoreStatus(
              match.status,
              match.status_text,
              match.time,
              match.competition
            ),


          raw_status:
            match.status ||
            "",


          status_text:
            match.status_text ||
            "",


          batting_team:
            match.batting_team ||
            null,


          overs:
            extractOvers(
              match.overs
            ),


          time:
            match.time ||
            null,


          competition:
            match.competition ||
            "Cricket",


          competition_logo:
            match.competition_logo ||
            "",


          url:
            match.url ||
            "",


          live_minute:
            match.live_minute ||
            null

        };

      });


    console.log(
      "SportScore normalized matches:",
      JSON.stringify(
        normalized
      )
    );


    return json({

      sport:
        "cricket",

      count:
        normalized.length,

      updated:
        payload.updated ||
        null,

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
   LIVE SCORE ENDPOINT
========================================================= */

async function handleLiveScores() {

  try {

    const response = await fetch(
      "https://sportscore.com/api/widget/matches/?sport=cricket&limit=50",
      {
        cf: {
          cacheTtl: 5,
          cacheEverything: true
        }
      }
    );


    if (!response.ok) {

      throw new Error(
        `SportScore returned HTTP ${response.status}`
      );

    }


    const payload =
      await response.json();


    const matches =
      Array.isArray(payload.matches)
        ? payload.matches
        : [];


    const scores = {};


    for (
      const match of matches
    ) {

      const key =
        match.url
          ? normalizeUrl(
              match.url
            )
          : null;


      if (!key) {
        continue;
      }


      scores[key] = {

        home:
          match.home ||
          "",


        away:
          match.away ||
          "",


        home_score:
          extractScore(
            match.home_score
          ),


        away_score:
          extractScore(
            match.away_score
          ),


        status:
          match.status ||
          null,


        status_text:
          match.status_text ||
          null,


        batting_team:
          match.batting_team ||
          null,


        overs:
          extractOvers(
            match.overs
          ),


        time:
          match.time ||
          null

      };

    }


    return json({

      scores,

      updated:
        new Date().toISOString()

    });


  } catch (error) {

    console.error(
      "Live scores error:",
      error
    );


    /*
     * Do NOT crash the homepage.
     */

    return json(
      {
        scores: {},

        error:
          error.message,

        updated:
          new Date().toISOString()
      },
      200
    );

  }

}


/* =========================================================
   SCORE EXTRACTION
========================================================= */

function extractScore(value) {

  /*
   * Normal SportScore response:
   *
   * "225/1"
   */

  if (
    typeof value === "string" ||
    typeof value === "number"
  ) {

    return String(value);

  }


  /*
   * Object response support.
   */

  if (
    value &&
    typeof value === "object"
  ) {

    /*
     * Sometimes:
     *
     * {
     *   runs: 225,
     *   wickets: 1
     * }
     */

    const runs =
      value.runs ??
      value.total ??
      value.score ??
      null;


    const wickets =
      value.wickets ??
      value.outs ??
      null;


    if (
      runs !== null &&
      wickets !== null
    ) {

      return `${runs}/${wickets}`;

    }


    if (
      runs !== null
    ) {

      return String(
        runs
      );

    }

  }


  return null;

}


/* =========================================================
   OVERS EXTRACTION
========================================================= */

function extractOvers(value) {

  if (
    value === null ||
    value === undefined
  ) {

    return null;

  }


  if (
    typeof value === "string" ||
    typeof value === "number"
  ) {

    return String(value);

  }


  if (
    typeof value === "object"
  ) {

    return (
      value.current ??
      value.total ??
      value.overs ??
      null
    );

  }


  return null;

}


/* =========================================================
   STATUS NORMALIZATION
========================================================= */

function normalizeSportScoreStatus(
  status,
  statusText = "",
  matchTime = null,
  competition = ""
) {

  const value =
    String(
      status ||
      ""
    )
      .trim()
      .toLowerCase();


  const text =
    String(
      statusText ||
      ""
    )
      .trim()
      .toLowerCase();


  /*
   * LIVE
   */

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


  /*
   * FINISHED
   */

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


  /*
   * TIME FALLBACK
   */

  if (matchTime) {

    const start =
      new Date(
        matchTime
      );


    const now =
      new Date();


    if (
      !Number.isNaN(
        start.getTime()
      )
    ) {

      const elapsedHours =
        (
          now.getTime() -
          start.getTime()
        )
        /
        (
          1000 *
          60 *
          60
        );


      /*
       * Cricket matches can run
       * for several hours.
       */

      if (
        elapsedHours >= 0 &&
        elapsedHours <= 8
      ) {

        /*
         * Only use this fallback when
         * SportScore didn't explicitly
         * say upcoming.
         */

        if (
          value !== "upcoming" &&
          value !== "scheduled" &&
          value !== "not_started" &&
          value !== "not started"
        ) {

          return "Live";

        }

      }

    }

  }


  return "Upcoming";

}


/* =========================================================
   URL NORMALIZATION
========================================================= */

function normalizeUrl(value) {

  if (!value) {

    return "";

  }


  const url =
    String(
      value
    ).trim();


  if (
    url.startsWith("http")
  ) {

    return url.replace(
      /\/+$/,
      ""
    );

  }


  return (
    "https://sportscore.com" +

    (
      url.startsWith("/")
        ? url
        : `/${url}`
    )

  ).replace(
    /\/+$/,
    ""
  );

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
          "public, max-age=5",

        "access-control-allow-origin":
          "*"

      }
    }
  );

}
