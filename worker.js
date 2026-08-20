export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/cricket-matches") {
      return handleCricketAPI();
    }

    if (url.pathname === "/api/live-scores") {
      return handleLiveScores(url);
    }

    if (url.pathname === "/api/debug-score") {
      return handleDebugScore(url);
    }

    return env.ASSETS.fetch(request);
  }
};


/* =========================================================
   CRICKET MATCH FEED
========================================================= */

async function handleCricketAPI() {

  try {

    const response = await fetchWithRetry(
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

      throw new Error(
        `SportScore returned HTTP ${response.status}: ${body}`
      );
    }

    const payload = await response.json();

    const matches =
      Array.isArray(payload.matches)
        ? payload.matches
        : [];


    /*
     * First normalize the normal SportScore feed.
     */

    const normalized = matches.map(match => ({

      home:
        match.home || "",

      away:
        match.away || "",

      home_logo:
        match.home_logo || "",

      away_logo:
        match.away_logo || "",

      status:
        normalizeSportScoreStatus(
          match.status,
          match.status_text,
          match.time
        ),

      status_text:
        match.status_text || "",

      time:
        match.time || null,

      competition:
        match.competition || "Cricket",

      competition_logo:
        match.competition_logo || "",

      url:
        match.url || "",

      score:
        match.score || null,

      home_score:
        match.home_score ?? null,

      away_score:
        match.away_score ?? null

    }));


    /*
     * IMPORTANT:
     *
     * Only request detailed information for matches that
     * SportScore itself says are LIVE.
     *
     * Upcoming and Finished matches do NOT cause additional
     * SportScore requests.
     */

    const liveMatches =
      normalized.filter(
        match =>
          String(match.status).toLowerCase() === "live"
      );


    /*
     * Fetch detailed scores concurrently.
     *
     * This is the important change.
     */

    await Promise.all(
      liveMatches.map(
        async match => {

          if (!match.url) {
            return;
          }

          try {

            const detail =
              await fetchLiveMatchDetail(
                match.url
              );


            if (!detail) {
              return;
            }


            /*
             * SportScore's actual response:
             *
             * match.home_score
             * match.away_score
             * match.status
             * match.status_text
             */

            if (
              detail.home_score !== undefined &&
              detail.home_score !== null
            ) {

              match.home_score =
                detail.home_score;

            }


            if (
              detail.away_score !== undefined &&
              detail.away_score !== null
            ) {

              match.away_score =
                detail.away_score;

            }


            if (
              detail.status_text
            ) {

              match.status_text =
                detail.status_text;

            }


            if (
              detail.status
            ) {

              match.status =
                normalizeSportScoreStatus(
                  detail.status,
                  detail.status_text,
                  detail.time
                );

            }


            /*
             * Keep the detailed score object too.
             */

            match.score = {

              home_score:
                detail.home_score ?? null,

              away_score:
                detail.away_score ?? null,

              status:
                detail.status ?? null,

              status_text:
                detail.status_text ?? null

            };

          } catch (error) {

            /*
             * One failed live match must NOT prevent
             * the other live matches from loading.
             */

            console.error(
              "Unable to fetch live score:",
              match.home,
              "vs",
              match.away,
              error
            );

          }

        }
      )
    );


    return json({

      sport:
        "cricket",

      count:
        normalized.length,

      updated:
        payload.updated ||
        new Date().toISOString(),

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
   FETCH ONE LIVE MATCH DETAIL
========================================================= */

async function fetchLiveMatchDetail(
  sourceUrl
) {

  const normalizedUrl =
    normalizeUrl(sourceUrl);


  const slug =
    extractMatchSlug(
      normalizedUrl
    );


  if (!slug) {
    return null;
  }


  const endpoint =
    `https://sportscore.com/api/widget/match/?sport=cricket&slug=${encodeURIComponent(slug)}`;


  const response =
    await fetchWithRetry(
      endpoint,
      {
        cf: {
          /*
           * Short cache for live scores.
           */

          cacheTtl: 10,
          cacheEverything: true
        }
      }
    );


  if (!response.ok) {

    throw new Error(
      `SportScore detail HTTP ${response.status}`
    );

  }


  const payload =
    await response.json();


  if (
    !payload ||
    !payload.match ||
    typeof payload.match !== "object"
  ) {

    return null;

  }


  return payload.match;

}


/* =========================================================
   STREAM PAGE LIVE SCORE ENDPOINT
========================================================= */

async function handleLiveScores(url) {

  try {

    const sourceUrl =
      url.searchParams.get("url");


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


    const match =
      await fetchLiveMatchDetail(
        sourceUrl
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


    const homeScore =
      match.home_score ?? null;

    const awayScore =
      match.away_score ?? null;

    const status =
      match.status ?? null;

    const statusText =
      match.status_text ?? null;


    if (
      homeScore === null &&
      awayScore === null
    ) {

      return json({

        score:
          null,

        status:
          normalizeSportScoreStatus(
            status,
            statusText,
            match.time
          ),

        status_text:
          statusText,

        updated:
          new Date().toISOString()

      });

    }


    return json({

      score: {

        home_score:
          homeScore,

        away_score:
          awayScore,

        overs:
          null,

        batting_team:
          null,

        status:
          status,

        status_text:
          statusText,

        home:
          match.home ||
          null,

        away:
          match.away ||
          null

      },

      status:
        normalizeSportScoreStatus(
          status,
          statusText,
          match.time
        ),

      status_text:
        statusText,

      updated:
        new Date().toISOString()

    });


  } catch (error) {

    console.error(
      "Live scores error:",
      error
    );


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
   DEBUG SCORE ENDPOINT
========================================================= */

async function handleDebugScore(url) {

  const sourceUrl =
    url.searchParams.get("url");


  if (!sourceUrl) {

    return json(
      {
        error:
          "Missing ?url=<SportScore match URL>"
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

        sourceUrl:
          normalizedSourceUrl
      },
      400
    );

  }


  const endpoint =
    `https://sportscore.com/api/widget/match/?sport=cricket&slug=${encodeURIComponent(slug)}`;


  try {

    const response =
      await fetch(
        endpoint,
        {
          cf: {
            cacheTtl: 0,
            cacheEverything: false
          }
        }
      );


    const rawBody =
      await response.text();


    return new Response(
      JSON.stringify(
        {
          requested_url:
            endpoint,

          sportscore_http_status:
            response.status,

          sportscore_ok:
            response.ok,

          response:
            rawBody
        },
        null,
        2
      ),
      {
        status: 200,

        headers: {
          "content-type":
            "application/json",

          "cache-control":
            "no-store",

          "access-control-allow-origin":
            "*"
        }
      }
    );


  } catch (error) {

    return json(
      {
        error:
          error.message ||
          "Debug request failed.",

        requested_url:
          endpoint
      },
      500
    );

  }

}


/* =========================================================
   STATUS
========================================================= */

function normalizeSportScoreStatus(
  status,
  statusText = "",
  matchTime = null
) {

  const value =
    String(
      status || ""
    )
      .trim()
      .toLowerCase();


  const text =
    String(
      statusText || ""
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

function normalizeUrl(value) {

  if (!value) {
    return "";
  }


  const url =
    String(value).trim();


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
   EXTRACT MATCH SLUG
========================================================= */

function extractMatchSlug(value) {

  try {

    const parsed =
      new URL(
        normalizeUrl(value)
      );


    const parts =
      parsed.pathname
        .split("/")
        .filter(Boolean);


    const matchIndex =
      parts.findIndex(
        part =>
          part.toLowerCase() ===
          "match"
      );


    if (
      matchIndex === -1 ||
      !parts[matchIndex + 1]
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
   RETRY
========================================================= */

async function fetchWithRetry(
  resource,
  options = {},
  maxAttempts = 3
) {

  let lastError = null;


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


      if (
        (
          response.status === 429 ||
          response.status === 500 ||
          response.status === 502 ||
          response.status === 503 ||
          response.status === 504
        ) &&
        attempt < maxAttempts
      ) {

        await sleep(
          700 * attempt
        );

        continue;

      }


      return response;

    } catch (error) {

      lastError = error;


      if (
        attempt < maxAttempts
      ) {

        await sleep(
          700 * attempt
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

function sleep(milliseconds) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        milliseconds
      )
  );

}


/* =========================================================
   JSON
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
          "public, max-age=10",

        "access-control-allow-origin":
          "*"
      }
    }
  );

}
