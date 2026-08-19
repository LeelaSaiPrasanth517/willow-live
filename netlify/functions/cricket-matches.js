export default async (request) => {
  try {
    const apiToken = process.env.SPORTMONKS_API_TOKEN;

    if (!apiToken) {
      return json(
        {
          error: "SPORTMONKS_API_TOKEN is missing."
        },
        500
      );
    }

    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") || "matches";


    /* =========================================================
       MATCHES
       ========================================================= */

    if (mode === "matches") {

      const matches = await fetchCurrentFixtures(apiToken);

      return json({
        matches
      });
    }


    /* =========================================================
       LIVE SCORES
       ========================================================= */

    if (mode === "scores") {

      const matches =
        await fetchLiveFixtures(apiToken);

      return json({
        matches
      });
    }


    return json(
      {
        error: "Unknown mode."
      },
      400
    );

  } catch (error) {

    console.error(
      "Cricketive Sportmonks error:",
      error
    );

    return json(
      {
        error:
          error.message ||
          "Unexpected server error."
      },
      500
    );
  }
};


/* =============================================================
   FETCH CURRENT + UPCOMING FIXTURES
   ============================================================= */

async function fetchCurrentFixtures(apiToken) {

  /*
   * Current date.
   *
   * We request a window around today instead of downloading
   * the entire historical fixture database.
   */

  const now = new Date();

  const startDate =
    formatDate(
      new Date(
        now.getTime() -
        24 * 60 * 60 * 1000
      )
    );

  const endDate =
    formatDate(
      new Date(
        now.getTime() +
        14 * 24 * 60 * 60 * 1000
      )
    );


  const allFixtures = [];


  /*
   * Sportmonks paginates fixture results.
   */

  let page = 1;

  const maxPages = 20;


  for (
    let i = 0;
    i < maxPages;
    i++
  ) {

    const endpoint =
      "https://cricket.sportmonks.com/api/v2.0/fixtures";


    const params =
      new URLSearchParams({

        api_token:
          apiToken,

        page:
          String(page),

        "filter[starts_between]":
          `${startDate},${endDate}`,

        include:
          "localteam,visitorteam,venue"

      });


    const response =
      await fetch(
        `${endpoint}?${params.toString()}`
      );


    if (!response.ok) {

      throw new Error(
        `Sportmonks returned HTTP ${response.status}`
      );
    }


    const result =
      await response.json();


    if (!result.data) {

      throw new Error(
        result.message ||
        "Sportmonks returned no fixture data."
      );
    }


    /*
     * Sportmonks can return either an array or,
     * depending on the endpoint response, a single object.
     */

    const fixtures =
      Array.isArray(result.data)
        ? result.data
        : [result.data];


    allFixtures.push(
      ...fixtures
    );


    /*
     * Stop when there are no more pages.
     */

    const meta =
      result.meta;


    if (
      !meta ||
      !meta.current_page ||
      !meta.last_page ||
      meta.current_page >= meta.last_page
    ) {

      break;
    }


    page++;
  }


  /*
   * Convert Sportmonks fixtures into the format
   * already used by Cricketive.
   */

  const normalized =
    allFixtures
      .map(normalizeSportmonksFixture)
      .filter(Boolean)
      .filter(
        match =>
          !isPlaceholder(match.team1) &&
          !isPlaceholder(match.team2)
      );


  /*
   * Remove duplicates.
   */

  const unique =
    new Map();


  for (
    const match of normalized
  ) {

    unique.set(
      match.api_match_id,
      match
    );
  }


  return Array.from(
    unique.values()
  );
}


/* =============================================================
   LIVE FIXTURES
   ============================================================= */

async function fetchLiveFixtures(apiToken) {

  const params =
    new URLSearchParams({

      api_token:
        apiToken,

      include:
        "localteam,visitorteam,venue"

    });


  const response =
    await fetch(
      `https://cricket.sportmonks.com/api/v2.0/livescores?${params.toString()}`
    );


  if (!response.ok) {

    throw new Error(
      `Sportmonks returned HTTP ${response.status}`
    );
  }


  const result =
    await response.json();


  const fixtures =
    Array.isArray(result.data)
      ? result.data
      : [];


  return fixtures
    .map(normalizeSportmonksFixture)
    .filter(Boolean);
}


/* =============================================================
   NORMALIZE SPORTMONKS FIXTURE
   ============================================================= */

function normalizeSportmonksFixture(fixture) {

  if (
    !fixture ||
    !fixture.id
  ) {

    return null;
  }


  /*
   * Sportmonks may return team information through
   * the included localteam / visitorteam objects.
   */

  const localTeam =
    getIncludedTeam(
      fixture.localteam
    );


  const visitorTeam =
    getIncludedTeam(
      fixture.visitorteam
    );


  const team1 =
    localTeam.name ||
    fixture.localteam_name ||
    "";


  const team2 =
    visitorTeam.name ||
    fixture.visitorteam_name ||
    "";


  /*
   * If the API didn't provide team names,
   * don't create a broken database record.
   */

  if (
    !team1 ||
    !team2
  ) {

    return null;
  }


  const startTime =
    fixture.starting_at ||
    null;


  if (!startTime) {

    return null;
  }


  const status =
    getMatchStatus(
      fixture
    );


  const competition =
    fixture.league_name ||
    fixture.league?.name ||
    "Cricket";


  const venue =
    fixture.venue?.name ||
    fixture.venue_name ||
    "";


  return {

    /*
     * This is the value your Supabase
     * api_match_id column will use.
     */

    api_match_id:
      String(fixture.id),


    title:
      `${team1} vs ${team2}`,


    team1,

    team2,


    competition,


    venue,


    start_time:
      startTime,


    match_time:
      startTime,


    status,


    team1_logo:
      localTeam.image_path ||
      localTeam.logo_url ||
      "",


    team2_logo:
      visitorTeam.image_path ||
      visitorTeam.logo_url ||
      "",


    /*
     * Streams are managed separately.
     */

    embed_url: ""
  };
}


/* =============================================================
   GET TEAM OBJECT
   ============================================================= */

function getIncludedTeam(team) {

  if (!team) {

    return {};
  }


  /*
   * Depending on the API response,
   * the included relationship can be
   * returned as an object or array.
   */

  if (Array.isArray(team)) {

    return team[0] || {};
  }


  return team;
}


/* =============================================================
   MATCH STATUS
   ============================================================= */

function getMatchStatus(fixture) {

  /*
   * Sportmonks provides a live boolean.
   */

  if (
    fixture.live === true
  ) {

    return "Live";
  }


  const status =
    String(
      fixture.status || ""
    ).toLowerCase();


  if (
    status.includes("finished") ||
    status.includes("completed") ||
    status.includes("abandoned") ||
    status.includes("cancelled")
  ) {

    return "Finished";
  }


  return "Upcoming";
}


/* =============================================================
   PLACEHOLDER CHECK
   ============================================================= */

function isPlaceholder(value) {

  if (!value) {

    return true;
  }


  return /^(tbc|tbd|to be confirmed|to be decided)$/i
    .test(
      String(value).trim()
    );
}


/* =============================================================
   DATE FORMAT
   ============================================================= */

function formatDate(date) {

  const year =
    date.getUTCFullYear();


  const month =
    String(
      date.getUTCMonth() + 1
    ).padStart(2, "0");


  const day =
    String(
      date.getUTCDate()
    ).padStart(2, "0");


  return `${year}-${month}-${day}`;
}


/* =============================================================
   JSON RESPONSE
   ============================================================= */

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
          "public, max-age=60"
      }
    }
  );
}
