/* =========================================================
   RUNTIME RESILIENCE
========================================================= */

let lastSuccessfulMatchFeed = null;
let lastSuccessfulMatchFeedAt = 0;

const MATCH_FEED_STALE_MS = 5 * 60 * 1000;

async function fetchWithRetry(
  url,
  options = {},
  attempts = 3,
  timeoutMs = 8000
) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs
    );

    try {
      const response = await fetch(
        url,
        {
          ...options,
          signal: controller.signal
        }
      );

      if (response.ok) {
        return response;
      }

      lastError = new Error(
        `HTTP ${response.status}`
      );

      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      ) {
        throw lastError;
      }

    } catch (error) {
      lastError = error;

    } finally {
      clearTimeout(timer);
    }

    if (attempt < attempts) {
      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            250 * Math.pow(2, attempt - 1)
          )
      );
    }
  }

  throw lastError ||
    new Error("Request failed.");
}

async function fetchJsonWithRetry(
  url,
  options = {},
  attempts = 3,
  timeoutMs = 8000
) {
  const response =
    await fetchWithRetry(
      url,
      options,
      attempts,
      timeoutMs
    );

  return response.json();
}

async function mapWithConcurrency(
  items,
  limit,
  mapper
) {
  const results =
    new Array(items.length);

  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) {
        return;
      }

      results[index] =
        await mapper(
          items[index],
          index
        );
    }
  }

  await Promise.all(
    Array.from(
      {
        length:
          Math.min(
            limit,
            items.length
          )
      },
      () => worker()
    )
  );

  return results;
}

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

      return handleLiveScores(request);

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
    const payload =
      await fetchJsonWithRetry(
        "https://sportscore.com/api/widget/matches/?sport=cricket&limit=50&src=cricketive",
        {
          cf: {
            cacheTtl: 10,
            cacheEverything: true
          }
        },
        3,
        8000
      );

    const matches =
      Array.isArray(
        payload.matches
      )
        ? payload.matches
        : [];

    /*
     * Enrich only live matches and cap concurrency.
     * This avoids a burst of individual requests when many
     * cricket matches are live at the same time.
     */
    const normalized =
      await mapWithConcurrency(
        matches,
        5,
        async match => {
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

          if (
            isLiveStatus(
              match.status,
              match.status_text
            ) &&
            match.url
          ) {
            try {
              const details =
                await getIndividualMatch(
                  match.url
                );

              if (details) {
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

            } catch (detailError) {
              console.error(
                "Individual match error:",
                match.url,
                detailError
              );
            }
          }

          return {
            home:
              match.home || "",
            away:
              match.away || "",
            home_logo:
              match.home_logo || "",
            away_logo:
              match.away_logo || "",
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
              match.time || null,
            competition:
              match.competition ||
              "Cricket",
            competition_logo:
              match.competition_logo ||
              "",
            url:
              match.url || "",
            score:
              match.score || null,
            live_minute:
              match.live_minute || null
          };
        }
      );

    const result = {
      sport: "cricket",
      count: normalized.length,
      updated:
        payload.updated ||
        new Date().toISOString(),
      matches:
        normalized,
      stale: false
    };

    lastSuccessfulMatchFeed =
      result;

    lastSuccessfulMatchFeedAt =
      Date.now();

    return json(result);

  } catch (error) {
    console.error(
      "Cricketive Worker error:",
      error
    );

    if (
      lastSuccessfulMatchFeed &&
      (
        Date.now() -
        lastSuccessfulMatchFeedAt
      ) <= MATCH_FEED_STALE_MS
    ) {
      return json({
        ...lastSuccessfulMatchFeed,
        stale: true,
        stale_reason:
          "SportScore temporarily unavailable; showing the last successful feed."
      });
    }

    return json(
      {
        error:
          error.message ||
          "Unable to load cricket matches."
      },
      503
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


  const payload =
    await fetchJsonWithRetry(
      apiUrl,
      {
        cf: {
          cacheTtl: 10,
          cacheEverything: true
        }
      },
      2,
      7000
    );


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

async function handleLiveScores(request) {
  try {
    const requestUrl =
      new URL(
        request.url
      );

    const requestedSource =
      requestUrl.searchParams.get(
        "url"
      ) || "";

    const payload =
      await fetchJsonWithRetry(
        "https://sportscore.com/api/widget/matches/?sport=cricket&limit=50&src=cricketive",
        {
          cf: {
            cacheTtl: 5,
            cacheEverything: true
          }
        },
        3,
        8000
      );

    const matches =
      Array.isArray(
        payload.matches
      )
        ? payload.matches
        : [];

    /*
     * stream.html requests one match and expects payload.score.
     */
    if (requestedSource) {
      const normalizedRequested =
        normalizeUrl(
          requestedSource
        );

      const source =
        matches.find(
          match =>
            normalizeUrl(
              match.url
            ) ===
            normalizedRequested
        );

      if (!source) {
        return json({
          score: null,
          error:
            "Live match not found in the current SportScore feed.",
          updated:
            new Date().toISOString()
        });
      }

      if (
        !isLiveStatus(
          source.status,
          source.status_text
        )
      ) {
        return json({
          score: null,
          error:
            "Match is not currently live.",
          updated:
            new Date().toISOString()
        });
      }

      try {
        const details =
          await getIndividualMatch(
            source.url
          );

        return json({
          score: {
            home:
              source.home || "",
            away:
              source.away || "",
            home_score:
              extractScore(
                details?.home_score ??
                source.home_score
              ),
            away_score:
              extractScore(
                details?.away_score ??
                source.away_score
              ),
            status:
              details?.status ||
              source.status ||
              null,
            status_text:
              details?.status_text ||
              source.status_text ||
              null,
            batting_team:
              details?.batting_team ||
              source.batting_team ||
              null,
            overs:
              extractOvers(
                details?.overs ??
                source.overs
              ),
            time:
              details?.time ||
              source.time ||
              null
          },
          updated:
            new Date().toISOString()
        });

      } catch (error) {
        console.error(
          "Requested live score failed:",
          error
        );

        return json({
          score: {
            home:
              source.home || "",
            away:
              source.away || "",
            home_score:
              extractScore(
                source.home_score
              ),
            away_score:
              extractScore(
                source.away_score
              ),
            status:
              source.status || null,
            status_text:
              source.status_text || null,
            batting_team:
              source.batting_team ||
              null,
            overs:
              extractOvers(
                source.overs
              ),
            time:
              source.time || null
          },
          stale: true,
          stale_reason:
            "Individual score endpoint temporarily unavailable.",
          updated:
            new Date().toISOString()
        });
      }
    }

    const liveMatches =
      matches.filter(
        match =>
          isLiveStatus(
            match.status,
            match.status_text
          ) &&
          match.url
      );

    const scoreRows =
      await mapWithConcurrency(
        liveMatches,
        5,
        async match => {
          try {
            const details =
              await getIndividualMatch(
                match.url
              );

            return {
              key:
                normalizeUrl(
                  match.url
                ),
              score: {
                home:
                  match.home || "",
                away:
                  match.away || "",
                home_score:
                  extractScore(
                    details?.home_score ??
                    match.home_score
                  ),
                away_score:
                  extractScore(
                    details?.away_score ??
                    match.away_score
                  ),
                status:
                  details?.status ||
                  match.status ||
                  null,
                status_text:
                  details?.status_text ||
                  match.status_text ||
                  null,
                batting_team:
                  details?.batting_team ||
                  match.batting_team ||
                  null,
                overs:
                  extractOvers(
                    details?.overs ??
                    match.overs
                  ),
                time:
                  details?.time ||
                  match.time ||
                  null
              }
            };

          } catch (error) {
            console.error(
              "Live score lookup failed:",
              match.url,
              error
            );

            return null;
          }
        }
      );

    const scores = {};

    scoreRows.forEach(
      row => {
        if (row?.key) {
          scores[row.key] =
            row.score;
        }
      }
    );

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
