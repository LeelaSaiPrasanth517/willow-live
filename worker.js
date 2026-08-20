export default {
  async fetch(request, env) {

    const url = new URL(request.url);


    /* =====================================================
       CRICKET MATCH FEED
    ===================================================== */

    if (
      url.pathname ===
      "/api/cricket-matches"
    ) {

      return handleCricketAPI();

    }


    /* =====================================================
       LIVE SCORE
    ===================================================== */

    if (
      url.pathname ===
      "/api/live-scores"
    ) {

      return handleLiveScores(url);

    }


    /* =====================================================
       STATIC ASSETS
    ===================================================== */

    return env.ASSETS.fetch(
      request
    );

  }
};


/* =========================================================
   SPORTScore MATCH FEED
========================================================= */

async function handleCricketAPI() {

  try {

    const response =
      await fetchWithRetry(
        "https://sportscore.com/api/widget/matches/?sport=cricket&limit=50",
        {
          cf: {
            cacheTtl: 30,
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


    const normalized =
      matches.map(
        match => ({

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

          status:
            normalizeSportScoreStatus(
              match.status,
              match.status_text,
              match.time
            ),

          status_text:
            match.status_text ||
            "",

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

          score:
            match.score ||
            null

        })
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

   Called by stream.html:

   /api/live-scores?url=<SportScore match URL>
========================================================= */

async function handleLiveScores(
  url
) {

  try {

    const sourceUrl =
      url.searchParams.get(
        "url"
      );


    if (!sourceUrl) {

      return json(
        {
          error:
            "Missing SportScore match URL.",

          score:
            null

        },
        400
      );

    }


    const normalizedSourceUrl =
      normalizeUrl(
        sourceUrl
      );


    const slug =
      extractMatchSlug(
        normalizedSourceUrl
      );


    if (!slug) {

      return json(
        {
          error:
            "Could not extract SportScore match slug.",

          score:
            null

        },
        400
      );

    }


    /*
     * SportScore single-match endpoint.
     */

    const endpoint =
      `https://sportscore.com/api/widget/match/?sport=cricket&slug=${encodeURIComponent(slug)}`;


    const response =
      await fetchWithRetry(
        endpoint,
        {
          cf: {
            cacheTtl: 30,
            cacheEverything: true
          }
        }
      );


    if (!response.ok) {

      const body =
        await response.text();

      throw new Error(
        `SportScore score endpoint returned HTTP ${response.status}: ${body}`
      );

    }


    const payload =
      await response.json();


    const match =
      extractMatchObject(
        payload
      );


    if (!match) {

      return json({

        score:
          null,

        error:
          "SportScore returned no match detail.",

        updated:
          new Date().toISOString()

      });

    }


    const score =
      extractScore(
        match,
        payload
      );


    /*
     * Never invent a score.
     */

    if (!score) {

      return json({

        score:
          null,

        status:
          normalizeSportScoreStatus(
            match.status,
            match.status_text,
            match.time
          ),

        updated:
          new Date().toISOString()

      });

    }


    return json({

      score,

      status:
        normalizeSportScoreStatus(
          match.status,
          match.status_text,
          match.time
        ),

      updated:
        new Date().toISOString()

    });


  } catch (error) {

    console.error(
      "Live scores error:",
      error
    );


    /*
     * Do not break stream.html if SportScore
     * temporarily fails.
     */

    return json({

      score:
        null,

      error:
        error.message ||
        "Unable to load live score.",

      updated:
        new Date().toISOString()

    });

  }

}


/* =========================================================
   EXTRACT MATCH OBJECT
========================================================= */

function extractMatchObject(
  payload
) {

  if (
    !payload ||
    typeof payload !==
      "object"
  ) {

    return null;

  }


  if (
    payload.match &&
    typeof payload.match ===
      "object"
  ) {

    return payload.match;

  }


  if (
    payload.data &&
    typeof payload.data ===
      "object"
  ) {

    if (
      payload.data.match &&
      typeof payload.data.match ===
        "object"
    ) {

      return payload.data.match;

    }


    return payload.data;

  }


  return payload;

}


/* =========================================================
   EXTRACT SCORE
========================================================= */

function extractScore(
  match,
  payload
) {

  const rawScore =
    match.score ||
    match.scores ||
    payload.score ||
    payload.scores ||
    null;


  let homeScore =
    null;

  let awayScore =
    null;

  let overs =
    null;

  let battingTeam =
    null;


  /*
   * Normal score object.
   */

  if (
    rawScore &&
    typeof rawScore ===
      "object"
  ) {

    const home =
      rawScore.home ??
      rawScore.home_score ??
      rawScore.homeScore ??
      null;


    const away =
      rawScore.away ??
      rawScore.away_score ??
      rawScore.awayScore ??
      null;


    homeScore =
      normalizeScoreValue(
        home
      );


    awayScore =
      normalizeScoreValue(
        away
      );


    overs =
      normalizeOvers(
        rawScore.overs ??
        rawScore.over ??
        rawScore.current_over ??
        null
      );


    battingTeam =
      rawScore.batting_team ||
      rawScore.battingTeam ||
      null;

  }


  /*
   * Scores directly on match object.
   */

  if (
    homeScore === null
  ) {

    homeScore =
      normalizeScoreValue(
        match.home_score ??
        match.homeScore ??
        null
      );

  }


  if (
    awayScore === null
  ) {

    awayScore =
      normalizeScoreValue(
        match.away_score ??
        match.awayScore ??
        null
      );

  }


  if (
    overs === null
  ) {

    overs =
      normalizeOvers(
        match.overs ??
        match.current_over ??
        null
      );

  }


  if (
    !battingTeam
  ) {

    battingTeam =
      match.batting_team ||
      match.battingTeam ||
      null;

  }


  /*
   * Nothing usable.
   */

  if (
    homeScore === null &&
    awayScore === null &&
    overs === null
  ) {

    return null;

  }


  return {

    home_score:
      homeScore,

    away_score:
      awayScore,

    overs,

    batting_team:
      battingTeam,

    raw_status:
      match.status ||
      null,

    raw_status_text:
      match.status_text ||
      null

  };

}


/* =========================================================
   SCORE VALUE NORMALIZATION
========================================================= */

function normalizeScoreValue(
  value
) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {

    return null;

  }


  if (
    typeof value ===
      "number" ||
    typeof value ===
      "string"
  ) {

    return value;

  }


  if (
    typeof value !==
      "object"
  ) {

    return null;

  }


  const runs =
    value.runs ??
    value.run ??
    value.total ??
    value.score ??
    value.points ??
    null;


  const wickets =
    value.wickets ??
    value.wicket ??
    value.outs ??
    value.dismissals ??
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


  return null;

}


/* =========================================================
   OVERS NORMALIZATION
========================================================= */

function normalizeOvers(
  value
) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {

    return null;

  }


  if (
    typeof value ===
      "number" ||
    typeof value ===
      "string"
  ) {

    return value;

  }


  if (
    typeof value !==
      "object"
  ) {

    return null;

  }


  return (
    value.current ??
    value.overs ??
    value.over ??
    value.total ??
    null
  );

}


/* =========================================================
   EXTRACT SPORTScore MATCH SLUG
========================================================= */

function extractMatchSlug(
  value
) {

  try {

    const parsed =
      new URL(
        normalizeUrl(
          value
        )
      );


    const parts =
      parsed.pathname
        .split("/")
        .filter(
          Boolean
        );


    const matchIndex =
      parts.findIndex(
        part =>
          part.toLowerCase() ===
          "match"
      );


    if (
      matchIndex === -1 ||
      !parts[
        matchIndex + 1
      ]
    ) {

      return "";

    }


    return parts[
      matchIndex + 1
    ];

  } catch {

    return "";

  }

}


/* =========================================================
   SPORTScore STATUS

   IMPORTANT:
   We do NOT calculate Live from start_time.
========================================================= */

function normalizeSportScoreStatus(
  status,
  statusText = "",
  matchTime = null
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


  return "Upcoming";

}


/* =========================================================
   URL NORMALIZATION
========================================================= */

function normalizeUrl(
  value
) {

  if (!value) {

    return "";

  }


  const url =
    String(
      value
    ).trim();


  if (
    url.startsWith(
      "http"
    )
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
   SPORTScore RETRY
========================================================= */

async function fetchWithRetry(
  resource,
  options = {},
  maxAttempts = 3
) {

  let lastError =
    null;


  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {

    try {

      const response =
        await fetch(
          resource,
          options
        );


      /*
       * Retry temporary upstream errors.
       */

      if (
        (
          response.status ===
            429 ||
          response.status ===
            500 ||
          response.status ===
            502 ||
          response.status ===
            503 ||
          response.status ===
            504
        ) &&
        attempt <
          maxAttempts
      ) {

        await sleep(
          700 *
          attempt
        );

        continue;

      }


      return response;


    } catch (
      error
    ) {

      lastError =
        error;


      if (
        attempt <
          maxAttempts
      ) {

        await sleep(
          700 *
          attempt
        );

        continue;

      }

    }

  }


  throw (
    lastError ||
    new Error(
      "SportScore request failed."
    )
  );

}


/* =========================================================
   SLEEP
========================================================= */

function sleep(
  milliseconds
) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        milliseconds
      )
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
          "public, max-age=10",

        "access-control-allow-origin":
          "*"

      }

    }
  );

}
