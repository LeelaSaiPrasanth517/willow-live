export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/cricket-matches") {
      return handleCricketAPI(request);
    }

    return env.ASSETS.fetch(request);
  }
};


/* =========================================================
   MAIN API
   ========================================================= */

async function handleCricketAPI(request) {
  try {
    const url = new URL(request.url);

    const mode =
      url.searchParams.get("mode") || "matches";


    /* =====================================================
       MATCHES
       ===================================================== */

    if (mode === "matches") {

      /*
       * First get the broad live/recent/upcoming feed.
       */

      const listResponse = await fetch(
        "https://sportscore.com/api/widget/matches/?sport=cricket&limit=50",
        {
          cf: {
            cacheTtl: 60,
            cacheEverything: true
          }
        }
      );


      if (!listResponse.ok) {

        const body =
          await listResponse.text();

        throw new Error(
          `SportScore matches returned HTTP ${listResponse.status}: ${body}`
        );
      }


      const listPayload =
        await listResponse.json();


      const listMatches =
        Array.isArray(
          listPayload.matches
        )
          ? listPayload.matches
          : [];


      /*
       * Only live matches need the expensive/detail lookup.
       *
       * Upcoming and finished matches can stay as returned
       * by the main list endpoint.
       */

      const enrichedMatches =
        await Promise.all(
          listMatches.map(
            async match => {

              const status =
                String(
                  match.status || ""
                ).toLowerCase();


              if (
                status !== "live" ||
                !match.url
              ) {

                return match;

              }


              const slug =
                extractSlug(
                  match.url
                );


              if (!slug) {

                return match;

              }


              try {

                const detail =
                  await fetchMatchDetail(
                    slug
                  );


                /*
                 * Merge only the fields we care about.
                 *
                 * The original list match remains intact,
                 * and the detail response can overwrite its
                 * score/status information when available.
                 */

                const score =
                  extractScore(
                    detail,
                    match
                  );


                const statusText =
                  extractStatusText(
                    detail
                  ) ||
                  match.status_text ||
                  "";


                return {
                  ...match,

                  home_score:
                    score.home_score,

                  away_score:
                    score.away_score,

                  status_text:
                    statusText,

                  detail_loaded:
                    true
                };


              } catch (error) {

                console.error(
                  `SportScore detail failed for ${slug}:`,
                  error
                );


                /*
                 * Don't break the whole feed because one
                 * match-detail request failed.
                 */

                return {
                  ...match,
                  detail_loaded: false
                };
              }

            }
          )
        );


      return json({
        sport:
          "cricket",

        count:
          enrichedMatches.length,

        updated:
          listPayload.updated || null,

        matches:
          enrichedMatches
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
   SPORTScore MATCH DETAIL
   ========================================================= */

async function fetchMatchDetail(
  slug
) {

  const url =
    `https://sportscore.com/api/widget/match/?sport=cricket&slug=${encodeURIComponent(slug)}`;


  const response =
    await fetch(
      url,
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
      `Detail HTTP ${response.status}: ${body}`
    );
  }


  return await response.json();
}


/* =========================================================
   EXTRACT SLUG FROM SportScore URL
   ========================================================= */

function extractSlug(
  value
) {

  if (!value) {
    return null;
  }


  try {

    /*
     * Handles:
     *
     * /cricket/match/england-vs-pakistan/
     *
     * https://sportscore.com/cricket/match/england-vs-pakistan/
     */

    const url =
      new URL(
        value,
        "https://sportscore.com"
      );


    const parts =
      url.pathname
        .split("/")
        .filter(Boolean);


    const matchIndex =
      parts.indexOf("match");


    if (
      matchIndex !== -1 &&
      parts[matchIndex + 1]
    ) {

      return parts[
        matchIndex + 1
      ];

    }


    /*
     * Fallback:
     * use the final non-empty path segment.
     */

    return (
      parts[parts.length - 1] ||
      null
    );


  } catch (
    error
  ) {

    return null;
  }
}


/* =========================================================
   SCORE EXTRACTION
   ========================================================= */

function extractScore(
  detail,
  fallback
) {

  const containers = [
    detail,
    detail?.match,
    detail?.data,
    detail?.match?.data,
    detail?.score,
    detail?.scoreboard,
    detail?.match?.score,
    detail?.match?.scoreboard
  ].filter(Boolean);


  let homeScore =
    findFirstScore(
      containers,
      [
        "home_score",
        "homeScore",
        "home"
      ]
    );


  let awayScore =
    findFirstScore(
      containers,
      [
        "away_score",
        "awayScore",
        "away"
      ]
    );


  /*
   * Search common nested score structures.
   */

  if (
    homeScore === null ||
    homeScore === undefined
  ) {

    homeScore =
      findNestedScore(
        detail,
        "home"
      );

  }


  if (
    awayScore === null ||
    awayScore === undefined
  ) {

    awayScore =
      findNestedScore(
        detail,
        "away"
      );

  }


  /*
   * If detail doesn't contain usable scores,
   * preserve the list endpoint's values.
   */

  if (
    !hasUsableScore(
      homeScore
    )
  ) {

    homeScore =
      fallback?.home_score ??
      null;

  }


  if (
    !hasUsableScore(
      awayScore
    )
  ) {

    awayScore =
      fallback?.away_score ??
      null;

  }


  return {
    home_score:
      normalizeScoreValue(
        homeScore
      ),

    away_score:
      normalizeScoreValue(
        awayScore
      )
  };
}


/* =========================================================
   FIND SIMPLE SCORE
   ========================================================= */

function findFirstScore(
  containers,
  keys
) {

  for (
    const container of containers
  ) {

    if (
      !container ||
      typeof container !== "object"
    ) {

      continue;
    }


    for (
      const key of keys
    ) {

      if (
        Object.prototype.hasOwnProperty.call(
          container,
          key
        )
      ) {

        const value =
          container[key];


        /*
         * Don't treat the team object itself as a score.
         */

        if (
          typeof value !== "object"
        ) {

          if (
            hasUsableScore(
              value
            )
          ) {

            return value;

          }

        }


        /*
         * If it's an object with a score-like
         * property, inspect it.
         */

        if (
          value &&
          typeof value === "object"
        ) {

          const nested =
            value.score ??
            value.runs ??
            value.value ??
            null;


          if (
            hasUsableScore(
              nested
            )
          ) {

            return nested;

          }

        }

      }

    }

  }


  return null;
}


/* =========================================================
   FIND NESTED TEAM SCORE
   ========================================================= */

function findNestedScore(
  value,
  side
) {

  if (
    !value ||
    typeof value !== "object"
  ) {

    return null;
  }


  /*
   * Direct team object.
   */

  if (
    value[side] &&
    typeof value[side] === "object"
  ) {

    const team =
      value[side];


    const direct =
      team.score ??
      team.runs ??
      team.value ??
      null;


    if (
      hasUsableScore(
        direct
      )
    ) {

      return direct;
    }

  }


  /*
   * Recursively search nested objects.
   *
   * This is deliberately defensive because the
   * detail schema can contain nested scoreboard data.
   */

  for (
    const key of Object.keys(value)
  ) {

    const child =
      value[key];


    if (
      child &&
      typeof child === "object"
    ) {

      const found =
        findNestedScore(
          child,
          side
        );


      if (
        hasUsableScore(
          found
        )
      ) {

        return found;
      }

    }

  }


  return null;
}


/* =========================================================
   STATUS TEXT
   ========================================================= */

function extractStatusText(
  detail
) {

  const candidates = [

    detail?.status_text,

    detail?.statusText,

    detail?.match?.status_text,

    detail?.match?.statusText,

    detail?.data?.status_text,

    detail?.data?.statusText,

    detail?.status?.text,

    detail?.match?.status?.text

  ];


  for (
    const value of candidates
  ) {

    if (
      value !== null &&
      value !== undefined &&
      String(value).trim()
    ) {

      return String(
        value
      );

    }

  }


  return "";
}


/* =========================================================
   SCORE VALIDATION
   ========================================================= */

function hasUsableScore(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return false;
  }


  const text =
    String(value).trim();


  return (
    text !== "" &&
    text !== "-"
  );
}


/* =========================================================
   NORMALIZE SCORE
   ========================================================= */

function normalizeScoreValue(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return null;
  }


  if (
    typeof value === "object"
  ) {

    const runs =
      value.runs ??
      value.score ??
      value.value ??
      null;


    if (
      runs === null ||
      runs === undefined
    ) {

      return null;
    }


    return String(
      runs
    );

  }


  const text =
    String(value).trim();


  if (
    !text ||
    text === "-"
  ) {

    return null;
  }


  return text;
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
