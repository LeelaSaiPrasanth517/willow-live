export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/cricket-matches") {
      return handleCricketAPI(request, env);
    }

    return new Response("Cricketive Worker is running.", {
      status: 200,
      headers: {
        "content-type": "text/plain"
      }
    });
  }
};


async function handleCricketAPI(request, env) {

  try {

    const apiToken =
      env.SPORTMONKS_API_TOKEN;

    if (!apiToken) {
      return json({
        error:
          "SPORTMONKS_API_TOKEN is missing."
      }, 500);
    }


    const url =
      new URL(request.url);

    const mode =
      url.searchParams.get("mode") ||
      "matches";


    if (mode === "matches") {

      const matches =
        await fetchFixtures(apiToken);

      return json({
        matches
      });
    }


    if (mode === "scores") {

      const matches =
        await fetchLivescores(apiToken);

      return json({
        matches
      });
    }


    return json({
      error: "Unknown mode."
    }, 400);


  } catch (error) {

    return json({
      error:
        error.message ||
        "Unexpected server error."
    }, 500);
  }
}


async function fetchFixtures(apiToken) {

  const now =
    new Date();


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


  const params =
    new URLSearchParams({

      api_token:
        apiToken,

      "filter[starts_between]":
        `${startDate},${endDate}`,

      include:
        "localteam,visitorteam,venue"

    });


  const response =
    await fetch(
      `https://cricket.sportmonks.com/api/v2.0/fixtures?${params}`
    );


  if (!response.ok) {

    throw new Error(
      `Sportmonks returned HTTP ${response.status}`
    );
  }


  const result =
    await response.json();


  if (!Array.isArray(result.data)) {

    return [];
  }


  return result.data
    .map(normalizeFixture)
    .filter(Boolean);
}


async function fetchLivescores(apiToken) {

  const params =
    new URLSearchParams({

      api_token:
        apiToken,

      include:
        "runs,batting,bowling,localteam,visitorteam,venue"

    });


  const response =
    await fetch(
      `https://cricket.sportmonks.com/api/v2.0/livescores?${params}`
    );


  if (!response.ok) {

    throw new Error(
      `Sportmonks livescores returned HTTP ${response.status}`
    );
  }


  const result =
    await response.json();


  if (!Array.isArray(result.data)) {

    return [];
  }


  return result.data
    .map(normalizeLiveMatch)
    .filter(Boolean);
}


function normalizeFixture(fixture) {

  if (
    !fixture ||
    !fixture.id ||
    !fixture.starting_at
  ) {
    return null;
  }


  const local =
    getTeam(fixture.localteam);


  const visitor =
    getTeam(fixture.visitorteam);


  const team1 =
    local.name || "";


  const team2 =
    visitor.name || "";


  if (!team1 || !team2) {

    return null;
  }


  const rawStatus =
    String(
      fixture.status || ""
    ).toLowerCase();


  const status =
    rawStatus.includes("finished") ||
    rawStatus.includes("completed") ||
    rawStatus.includes("abandoned") ||
    rawStatus.includes("cancelled")
      ? "Finished"
      : "Upcoming";


  return {

    api_match_id:
      String(fixture.id),

    title:
      `${team1} vs ${team2}`,

    team1,

    team2,

    competition:
      fixture.league?.name ||
      fixture.league_name ||
      "Cricket",

    venue:
      fixture.venue?.name ||
      fixture.venue_name ||
      "",

    start_time:
      fixture.starting_at,

    match_time:
      fixture.starting_at,

    status

  };
}


function normalizeLiveMatch(fixture) {

  if (
    !fixture ||
    !fixture.id
  ) {
    return null;
  }


  const local =
    getTeam(fixture.localteam);


  const visitor =
    getTeam(fixture.visitorteam);


  const team1 =
    local.name || "";


  const team2 =
    visitor.name || "";


  if (!team1 || !team2) {

    return null;
  }


  return {

    api_match_id:
      String(fixture.id),

    title:
      `${team1} vs ${team2}`,

    team1,

    team2,

    competition:
      fixture.league?.name ||
      fixture.league_name ||
      "Cricket",

    venue:
      fixture.venue?.name ||
      fixture.venue_name ||
      "",

    start_time:
      fixture.starting_at ||
      null,

    match_time:
      fixture.starting_at ||
      null,

    status:
      "Live",

    score:
      fixture.runs ||
      [],

    note:
      fixture.note ||
      ""

  };
}


function getTeam(team) {

  if (!team) {
    return {};
  }

  if (Array.isArray(team)) {
    return team[0] || {};
  }

  return team;
}


function formatDate(date) {

  return date
    .toISOString()
    .slice(0, 10);
}


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
          "public, max-age=30"
      }
    }
  );
}
