export default async (request) => {
  try {
    const apiKey = process.env.CRICKET_API_KEY;

    if (!apiKey) {
      return json(
        { error: "CRICKET_API_KEY is missing." },
        500
      );
    }

    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") || "matches";


    /* =========================================================
       SCHEDULE / MATCH LIST
       ========================================================= */

    if (mode === "matches") {

      const matches = await fetchAllMatches(apiKey);

      return json({
        matches
      });
    }


    /* =========================================================
       LIVE SCORES
       ========================================================= */

    if (mode === "scores") {

      const apiUrl =
        `https://api.cricapi.com/v1/currentMatches?apikey=${encodeURIComponent(apiKey)}&offset=0`;

      const response =
        await fetch(apiUrl);


      if (!response.ok) {

        throw new Error(
          `Cricket API returned HTTP ${response.status}`
        );
      }


      const result =
        await response.json();


      if (result.status !== "success") {

        throw new Error(
          result.info ||
          "Current Matches API failed."
        );
      }


      const matches =
        (result.data || [])
          .map(m => ({

            id:
              m.id,

            name:
              m.name,

            teams:
              m.teams || [],

            status:
              m.status || "",

            score:
              m.score || [],

            matchStarted:
              !!m.matchStarted,

            matchEnded:
              !!m.matchEnded,

            dateTimeGMT:
              m.dateTimeGMT || null

          }))
          .filter(m => m.id);


      return json({
        matches
      });
    }


    return json(
      {
        error:
          "Unknown mode."
      },
      400
    );


  } catch (error) {

    console.error(error);

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
   FETCH ALL MATCHES
   ============================================================= */

async function fetchAllMatches(apiKey) {

  const allMatches = [];

  /*
   * Cricket Data's match list uses offset pagination.
   *
   * Start at 0 and continue until the API gives us
   * fewer results than the requested page size.
   */

  const pageSize = 25;

  let offset = 0;


  /*
   * Safety limit.
   *
   * Prevents an accidental infinite API loop.
   */

  const maxPages = 10;


  for (
    let page = 0;
    page < maxPages;
    page++
  ) {

    const apiUrl =
      `https://api.cricapi.com/v1/matches` +
      `?apikey=${encodeURIComponent(apiKey)}` +
      `&offset=${offset}`;


    console.log(
      `Fetching matches offset ${offset}`
    );


    const response =
      await fetch(apiUrl);


    if (!response.ok) {

      throw new Error(
        `Cricket API returned HTTP ${response.status}`
      );
    }


    const result =
      await response.json();


    if (result.status !== "success") {

      throw new Error(
        result.info ||
        "Matches API failed."
      );
    }


    const pageMatches =
      Array.isArray(result.data)
        ? result.data
        : [];


    console.log(
      `Received ${pageMatches.length} matches`
    );


    /*
     * Normalize and filter this page.
     */

    const normalized =
      pageMatches
        .map(normalizeMatch)
        .filter(Boolean)
        .filter(
          m =>
            !isPlaceholder(m.team1) &&
            !isPlaceholder(m.team2)
        );


    allMatches.push(
      ...normalized
    );


    /*
     * If the API returned fewer records than
     * the page size, we've reached the end.
     */

    if (
      pageMatches.length < pageSize
    ) {

      break;
    }


    offset += pageSize;
  }


  /*
   * Remove duplicate matches.
   *
   * The API ID is the unique identifier.
   */

  const unique =
    new Map();


  for (
    const match of allMatches
  ) {

    if (
      match.api_match_id
    ) {

      unique.set(
        match.api_match_id,
        match
      );
    }
  }


  return Array.from(
    unique.values()
  );
}


/* =============================================================
   NORMALIZE MATCH
   ============================================================= */

function normalizeMatch(m) {

  const teams =
    Array.isArray(m.teams)
      ? m.teams
      : [];


  const team1 =
    teams[0] || "";


  const team2 =
    teams[1] || "";


  const startTime =
    m.dateTimeGMT ||
    m.dateTime ||
    null;


  /*
   * Never create an incomplete match.
   */

  if (
    !m.id ||
    !team1 ||
    !team2 ||
    !startTime
  ) {

    return null;
  }


  return {

    api_match_id:
      m.id,

    title:
      m.name ||
      `${team1} vs ${team2}`,

    team1,

    team2,

    competition:
      m.seriesName ||
      m.matchType ||
      "Cricket",

    venue:
      m.venue ||
      "",

    start_time:
      startTime,

    match_time:
      startTime,

    status:
      m.matchEnded
        ? "Finished"
        : m.matchStarted
          ? "Live"
          : "Upcoming"
  };
}


/* =============================================================
   PLACEHOLDER MATCH CHECK
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
