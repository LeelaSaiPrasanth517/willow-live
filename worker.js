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
   MAIN CRICKET API
   ========================================================= */

async function handleCricketAPI(request) {

  try {

    const url =
      new URL(request.url);

    const mode =
      url.searchParams.get("mode") || "matches";


    if (mode !== "matches") {

      return json(
        {
          error: "Unknown mode."
        },
        400
      );

    }


    /* =====================================================
       MAIN SPORTScore MATCH FEED
       ===================================================== */

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
      Array.isArray(payload.matches)
        ? payload.matches
        : [];


    /* =====================================================
       ENRICH LIVE MATCHES
       ===================================================== */

    const enrichedMatches =
      await Promise.all(

        matches.map(
          async (match) => {

            const status =
              String(
                match.status || ""
              )
                .trim()
                .toLowerCase();


            /*
             * Only live matches need the detail request.
             */

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
               * Keep scores from the main endpoint
               * only when they are real cricket scores.
               */

              let homeScore =
                validCricketScore(
                  match.home_score
                )
                  ? String(
                      match.home_score
                    )
                  : null;


              let awayScore =
                validCricketScore(
                  match.away_score
                )
                  ? String(
                      match.away_score
                    )
                  : null;


              /*
               * Try the detailed match endpoint.
               */

              const detailScores =
                extractValidScores(
                  detail
                );


              if (
                detailScores.home !== null
              ) {

                homeScore =
                  detailScores.home;

              }


              if (
                detailScores.away !== null
              ) {

                awayScore =
                  detailScores.away;

              }


              const statusText =
                extractStatusText(
                  detail
                ) ||
                match.status_text ||
                "";


              return {

                ...match,

                home_score:
                  homeScore,

                away_score:
                  awayScore,

                status_text:
                  statusText,

                detail_loaded:
                  true

              };


            } catch (error) {

              console.error(
                `SportScore detail lookup failed for ${slug}:`,
                error
              );


              /*
               * Don't break the whole feed because one
               * detail request failed.
               */

              return {

                ...match,

                detail_loaded:
                  false

              };

            }

          }
        )

      );


    /* =====================================================
       RESPONSE
       ===================================================== */

    return json({

      sport:
        "cricket",

      count:
        enrichedMatches.length,

      updated:
        payload.updated || null,

      matches:
        enrichedMatches

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
          "Unexpected Worker error."
      },
      500
    );

  }

}


/* =========================================================
   MATCH DETAIL
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
      `SportScore detail returned HTTP ${response.status}: ${body}`
    );

  }


  return await response.json();

}


/* =========================================================
   EXTRACT MATCH SLUG
   ========================================================= */

function extractSlug(
  value
) {

  if (!value) {
    return null;
  }


  try {

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
      parts.indexOf(
        "match"
      );


    if (
      matchIndex !== -1 &&
      parts[matchIndex + 1]
    ) {

      return parts[
        matchIndex + 1
      ];

    }


    return (
      parts[
        parts.length - 1
      ] || null
    );

  } catch {

    return null;

  }

}


/* =========================================================
   EXTRACT VALID SCORES
   ========================================================= */

function extractValidScores(
  detail
) {

  const result = {

    home:
      null,

    away:
      null

  };


  const containers = [

    detail,

    detail?.data,

    detail?.match,

    detail?.score,

    detail?.scoreboard,

    detail?.match?.score,

    detail?.match?.scoreboard

  ].filter(Boolean);


  for (
    const container of containers
  ) {

    if (
      !container ||
      typeof container !== "object"
    ) {

      continue;

    }


    /* -----------------------------------------------------
       HOME SCORE
       ----------------------------------------------------- */

    const homeCandidates = [

      container.home_score,

      container.homeScore,

      container.home_runs,

      container.homeRuns,

      container.local_score,

      container.localScore

    ];


    for (
      const value of homeCandidates
    ) {

      if (
        validCricketScore(
          value
        )
      ) {

        result.home =
          String(value);

        break;

      }

    }


    /* -----------------------------------------------------
       AWAY SCORE
       ----------------------------------------------------- */

    const awayCandidates = [

      container.away_score,

      container.awayScore,

      container.away_runs,

      container.awayRuns,

      container.visitor_score,

      container.visitorScore

    ];


    for (
      const value of awayCandidates
    ) {

      if (
        validCricketScore(
          value
        )
      ) {

        result.away =
          String(value);

        break;

      }

    }


    if (
      result.home !== null &&
      result.away !== null
    ) {

      break;

    }

  }


  /*
   * If explicit fields didn't work, inspect nested
   * score structures.
   */

  if (
    result.home === null
  ) {

    result.home =
      findNestedCricketScore(
        detail,
        "home"
      );

  }


  if (
    result.away === null
  ) {

    result.away =
      findNestedCricketScore(
        detail,
        "away"
      );

  }


  return result;

}


/* =========================================================
   NESTED SCORE SEARCH
   ========================================================= */

function findNestedCricketScore(
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
   * Direct side object:
   *
   * home: {
   *   score: "150/6"
   * }
   */

  if (
    value[side] &&
    typeof value[side] === "object"
  ) {

    const team =
      value[side];


    const candidates = [

      team.score,

      team.runs,

      team.value,

      team.score_text,

      team.scoreText

    ];


    for (
      const candidate of candidates
    ) {

      if (
        validCricketScore(
          candidate
        )
      ) {

        return String(
          candidate
        );

      }

    }

  }


  /*
   * Recursively inspect nested objects.
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

      const result =
        findNestedCricketScore(
          child,
          side
        );


      if (
        result !== null
      ) {

        return result;

      }

    }

  }


  return null;

}


/* =========================================================
   VALID CRICKET SCORE
   ========================================================= */

function validCricketScore(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return false;

  }


  if (
    typeof value !== "string" &&
    typeof value !== "number"
  ) {

    return false;

  }


  const text =
    String(
      value
    ).trim();


  if (
    !text ||
    text === "-"
  ) {

    return false;

  }


  /*
   * Accept common cricket score formats:
   *
   * 150/6
   * 228/5
   * 95
   * 0/0
   * 150/6 (20 ov)
   */

  return /^\d+(?:\.\d+)?(?:\/\d+)?(?:\s*\(\s*\d+(?:\.\d+)?\s*ov\s*\))?$/i
    .test(
      text
    );

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
      String(
        value
      ).trim()
    ) {

      return String(
        value
      );

    }

  }


  return "";

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
