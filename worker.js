export default {
  async fetch(request, env) {

    const url =
      new URL(request.url);


    /*
     * =====================================================
     * MATCH FEED
     * =====================================================
     */

    if (
      url.pathname === "/api/cricket-matches"
    ) {

      return handleCricketAPI();

    }


    /*
     * =====================================================
     * LIVE SCORES
     * =====================================================
     */

    if (
      url.pathname === "/api/live-scores"
    ) {

      return handleLiveScores();

    }


    /*
     * =====================================================
     * STATIC ASSETS
     * =====================================================
     */

    return env.ASSETS.fetch(
      request
    );

  }
};


/* =========================================================
   MAIN CRICKET API
========================================================= */

async function handleCricketAPI() {

  try {

    /*
     * -----------------------------------------------------
     * GET MATCH LIST
     * -----------------------------------------------------
     */

    const response =
      await fetch(
        "https://sportscore.com/api/widget/matches/?sport=cricket&limit=50",
        {
          cf: {
            cacheTtl: 5,
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
     * -----------------------------------------------------
     * PROCESS MATCHES
     * -----------------------------------------------------
     */

    const normalized =
      await Promise.all(

        matches.map(
          async match => {

            /*
             * Start with scores from
             * the list endpoint.
             */

            let homeScore =
              extractScore(
                match.home_score
              );


            let awayScore =
              extractScore(
                match.away_score
              );


            let statusText =
              match.status_text ||
              "";


            let battingTeam =
              match.batting_team ||
              null;


            let overs =
              extractOvers(
                match.overs
              );


            /*
             * -------------------------------------------------
             * LIVE MATCH:
             *
             * Get the INDIVIDUAL match endpoint.
             * This is where SportScore has the real score.
             * -------------------------------------------------
             */

            const isLive =
              isLiveStatus(
                match.status,
                match.status_text
              );


            if (
              isLive &&
              match.url
            ) {

              try {

                const details =
                  await getIndividualMatch(
                    match.url
                  );


                if (
                  details
                ) {

                  /*
                   * Use individual endpoint
                   * values when available.
                   */

                  const detailedHome =
                    extractScore(
                      details.home_score
                    );


                  const detailedAway =
                    extractScore(
                      details.away_score
                    );


                  if (
                    isRealScore(
                      detailedHome
                    )
                  ) {

                    homeScore =
                      detailedHome;

                  }


                  if (
                    isRealScore(
                      detailedAway
                    )
                  ) {

                    awayScore =
                      detailedAway;

                  }


                  if (
                    details.status_text
                  ) {

                    statusText =
                      details.status_text;

                  }


                  if (
                    details.batting_team
                  ) {

                    battingTeam =
                      details.batting_team;

                  }


                  if (
                    details.overs !==
                    undefined
                  ) {

                    overs =
                      extractOvers(
                        details.overs
                      );

                  }

                }

              } catch (
                detailError
              ) {

                console.error(
                  "Individual match error:",
                  match.url,
                  detailError
                );

              }

            }


            /*
             * -------------------------------------------------
             * RETURN NORMALIZED MATCH
             * -------------------------------------------------
             */

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


              home_score:
                homeScore,


              away_score:
                awayScore,


              status:
                normalizeSportScoreStatus(
                  match.status,
                  statusText,
                  match.time,
                  match.competition
                ),


              status_text:
                statusText,


              batting_team:
                battingTeam,


              overs:
                overs,


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
                null,


              live_minute:
                match.live_minute ||
                null

            };

          }
        )

      );


    /*
     * -----------------------------------------------------
     * DEBUG
     * -----------------------------------------------------
     */

    console.log(
      "FINAL MATCH DATA:",
      JSON.stringify(
        normalized
      )
    );


    /*
     * -----------------------------------------------------
     * RESPONSE
     * -----------------------------------------------------
     */

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


  } catch (
    error
  ) {

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
   GET INDIVIDUAL SPORTSCORE MATCH
========================================================= */

async function getIndividualMatch(
  matchUrl
) {

  /*
   * matchUrl example:
   *
   * /cricket/match/
   * nondescripts-vs-bloomfield-cricket-
   * and-athletic-club/
   */


  const slug =
    extractSlug(
      matchUrl
    );


  if (!slug) {

    throw new Error(
      "Could not extract SportScore match slug."
    );

  }


  const apiUrl =
    "https://sportscore.com/api/widget/match/" +
    "?sport=cricket" +
    `&slug=${encodeURIComponent(slug)}`;


  console.log(
    "Fetching individual match:",
    apiUrl
  );


  const response =
    await fetch(
      apiUrl,
      {
        cf: {
          cacheTtl: 5,
          cacheEverything: true
        }
      }
    );


  if (!response.ok) {

    throw new Error(
      `SportScore match endpoint returned HTTP ${response.status}`
    );

  }


  const payload =
    await response.json();


  /*
   * SportScore returns:
   *
   * {
   *   sport: "cricket",
   *   match: {...},
   *   updated: "..."
   * }
   */


  if (
    payload &&
    payload.match
  ) {

    return payload.match;

  }


  /*
   * Some responses may be wrapped
   * differently.
   */

  if (
    payload &&
    payload.data &&
    payload.data.match
  ) {

    return payload.data.match;

  }


  return null;

}


/* =========================================================
   EXTRACT SLUG
========================================================= */

function extractSlug(
  value
) {

  if (!value) {

    return null;

  }


  let url =
    String(
      value
    ).trim();


  /*
   * Remove query string.
   */

  url =
    url.split("?")[0];


  /*
   * Remove trailing slash.
   */

  url =
    url.replace(
      /\/+$/,
      ""
    );


  /*
   * Get final path segment.
   */

  const parts =
    url.split("/");


  const slug =
    parts[
      parts.length - 1
    ];


  if (
    !slug ||
    slug === "match"
  ) {

    return null;

  }


  return slug;

}


/* =========================================================
   LIVE STATUS CHECK
========================================================= */

function isLiveStatus(
  status,
  statusText
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


  return (

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

    text.includes(
      "innings"
    )

  );

}


/* =========================================================
   SCORE EXTRACTION
========================================================= */

function extractScore(
  value
) {

  /*
   * Empty / dash
   */

  if (
    value === null ||
    value === undefined ||
    value === "" ||
    value === "-"
  ) {

    return null;

  }


  /*
   * String:
   *
   * "225/1"
   */

  if (
    typeof value === "string"
  ) {

    return value;

  }


  /*
   * Number
   */

  if (
    typeof value === "number"
  ) {

    return String(
      value
    );

  }


  /*
   * Object
   */

  if (
    typeof value === "object"
  ) {

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

      return (
        `${runs}/${wickets}`
      );

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
   REAL SCORE CHECK
========================================================= */

function isRealScore(
  value
) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {

    return false;

  }


  if (
    value === "-"
  ) {

    return false;

  }


  return true;

}


/* =========================================================
   OVERS
========================================================= */

function extractOvers(
  value
) {

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

    return String(
      value
    );

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

    text.includes(
      "innings"
    )

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
   LIVE SCORES ENDPOINT
========================================================= */

async function handleLiveScores() {

  try {

    const response =
      await fetch(
        "https://sportscore.com/api/widget/matches/?sport=cricket&limit=150",
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
      Array.isArray(
        payload.matches
      )
        ? payload.matches
        : [];


    const scores =
      {};


    /*
     * Only query individual
     * endpoints for live matches.
     */

    await Promise.all(

      matches
        .filter(
          match =>
            isLiveStatus(
              match.status,
              match.status_text
            )
        )
        .map(
          async match => {

            try {

              const details =
                await getIndividualMatch(
                  match.url
                );


              if (!details) {

                return;

              }


              const key =
                normalizeUrl(
                  match.url
                );


              scores[key] = {

                home:
                  match.home ||
                  "",


                away:
                  match.away ||
                  "",


                home_score:
                  extractScore(
                    details.home_score
                  ),


                away_score:
                  extractScore(
                    details.away_score
                  ),


                status:
                  details.status ||
                  match.status ||
                  null,


                status_text:
                  details.status_text ||
                  match.status_text ||
                  null,


                batting_team:
                  details.batting_team ||
                  null,


                overs:
                  extractOvers(
                    details.overs
                  ),


                time:
                  details.time ||
                  match.time ||
                  null

              };

            } catch (
              error
            ) {

              console.error(
                "Live score lookup failed:",
                match.url,
                error
              );

            }

          }
        )

    );


    return json({

      scores,

      updated:
        new Date().toISOString()

    });


  } catch (
    error
  ) {

    console.error(
      "Live scores error:",
      error
    );


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
