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
            extractTeamScore(
              match,
              match,
              "home"
            );

          let awayScore =
            extractTeamScore(
              match,
              match,
              "away"
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
           * SportScore can occasionally return a stale/ambiguous
           * status on the list endpoint.  If a match has already
           * reached its scheduled start, fetch the individual match
           * as well so we can resolve LIVE vs FINISHED instead of
           * silently turning it into UPCOMING.
           */
          if (
            shouldRefreshMatchDetails(match)
          ) {
            try {
              const details =
                await getIndividualMatch(
                  match.url
                );

              if (details) {
                const detailedHome =
                  extractTeamScore(
                    details,
                    match,
                    "home"
                  );

                const detailedAway =
                  extractTeamScore(
                    details,
                    match,
                    "away"
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

                const detailedBatting = extractBattingTeam(details);
                if (detailedBatting) {
                  battingTeam = detailedBatting;
                }

                const detailedOvers = extractMatchOvers(details);
                if (detailedOvers !== null) {
                  overs = detailedOvers;
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
                match.competition,
                homeScore,
                awayScore,
                overs,
                battingTeam
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
              match.score || match.scores || null,
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


  if (payload && payload.match) {
    return payload.match;
  }

  if (payload && payload.data && payload.data.match) {
    return payload.data.match;
  }

  if (payload && payload.data && typeof payload.data === "object") {
    return payload.data;
  }

  /* Some SportScore responses may expose the match object directly. */
  if (payload && typeof payload === "object" && (payload.home_score || payload.away_score || payload.score || payload.scores || payload.innings || payload.status)) {
    return payload;
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

function normalizeStatusValue(value) {

  return String(
    value ||
    ""
  )
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");

}


function isExplicitFinishedStatus(
  status,
  statusText = ""
) {

  const value =
    normalizeStatusValue(status);

  const text =
    normalizeStatusValue(statusText);

  return (
    value === "finished" ||
    value === "finish" ||
    value === "ended" ||
    value === "end" ||
    value === "completed" ||
    value === "complete" ||
    value === "ft" ||
    value === "full_time" ||
    text === "finished" ||
    text === "ended" ||
    text === "completed" ||
    text === "complete" ||
    text.includes("match_finished") ||
    text.includes("match_ended") ||
    text.includes("won_by") ||
    text.includes("won_by_")
  );

}


function isExplicitLiveStatus(
  status,
  statusText = ""
) {

  const value =
    normalizeStatusValue(status);

  const text =
    normalizeStatusValue(statusText);

  return (
    value === "live" ||
    value === "in_progress" ||
    value === "started" ||
    value === "playing" ||
    value === "ongoing" ||
    value === "inplay" ||
    value === "in_play" ||
    text === "live" ||
    text === "in_progress" ||
    text === "started" ||
    text === "playing" ||
    text === "ongoing" ||
    text === "inplay" ||
    text === "in_play" ||
    text.includes("innings") ||
    text.includes("batting") ||
    text.includes("over_") ||
    text.includes("overs")
  );

}


function isLiveStatus(
  status,
  statusText
) {

  return isExplicitLiveStatus(
    status,
    statusText
  );

}


function hasLiveScoreEvidence(
  homeScore,
  awayScore,
  overs,
  battingTeam,
  statusText = ""
) {

  const text =
    String(
      statusText ||
      ""
    )
      .trim()
      .toLowerCase();

  return (
    isRealScore(homeScore) ||
    isRealScore(awayScore) ||
    overs !== null &&
    overs !== undefined &&
    String(overs).trim() !== "" ||
    Boolean(battingTeam) ||
    text.includes("innings") ||
    text.includes("batting") ||
    /\b\d+(?:\.\d+)?\s*overs?\b/.test(text) ||
    /\b\d+\/\d+\b/.test(text)
  );

}


function getMatchStartTime(
  matchTime
) {

  if (!matchTime) {
    return NaN;
  }

  const time =
    new Date(matchTime).getTime();

  return Number.isFinite(time)
    ? time
    : NaN;

}


function isLimitedOversCompetition(
  competition = ""
) {

  const text =
    String(competition)
      .trim()
      .toLowerCase();

  return (
    /\bt20\b/.test(text) ||
    /\bt20i\b/.test(text) ||
    /\bodi\b/.test(text) ||
    /\bt10\b/.test(text) ||
    text.includes("the hundred") ||
    text.includes("100-ball") ||
    text.includes("one day") ||
    text.includes("list a") ||
    text.includes("premier league") ||
    text.includes("premier league, women") ||
    text.includes("world cup") ||
    text.includes("qualifier") ||
    text.includes("cpl") ||
    text.includes("tnpl") ||
    text.includes("dpl") ||
    text.includes("sa20") ||
    text.includes("bbl") ||
    text.includes("psl") ||
    text.includes("ipl")
  );

}


function shouldRefreshMatchDetails(
  match
) {

  if (!match || !match.url) {
    return false;
  }

  if (
    isExplicitLiveStatus(
      match.status,
      match.status_text
    )
  ) {
    return true;
  }

  if (
    isExplicitFinishedStatus(
      match.status,
      match.status_text
    )
  ) {
    return false;
  }

  const startTime =
    getMatchStartTime(
      match.time ||
      match.start_time ||
      match.match_time
    );

  return (
    Number.isFinite(startTime) &&
    startTime <= Date.now() + 2 * 60 * 1000
  );

}


/* =========================================================
   CRICKET SCORE EXTRACTION

   SportScore's cricket payload can expose scores in more than one
   shape (home_score/away_score, score.home/score.away, nested score
   objects, or innings arrays). Keep the extraction tolerant so a
   schema variation does not turn a live score into "—".
========================================================= */

function cleanScoreText(value) {
  if (value === null || value === undefined) return null;

  const text = String(value).trim();
  if (!text || text === "-" || text === "—") return null;

  return text;
}

function scoreObjectToText(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === "string" || typeof value === "number") {
    const text = cleanScoreText(value);
    if (!text) return null;

    /* Accept normal cricket score strings such as 225/1, 225/1 (48.2). */
    if (/^\d+(?:\.\d+)?(?:\/\d+)?(?:\s*\([^)]*\))?$/.test(text)) {
      return text;
    }

    /* Also accept provider strings that contain a score. */
    const match = text.match(/\b\d+(?:\.\d+)?\/\d+\b/);
    return match ? match[0] : text;
  }

  if (typeof value !== "object") return null;

  const runs =
    value.runs ??
    value.run ??
    value.total_runs ??
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

  if (runs !== null && runs !== undefined && runs !== "") {
    const r = String(runs).trim();
    if (wickets !== null && wickets !== undefined && wickets !== "") {
      return `${r}/${wickets}`;
    }
    return r;
  }

  if (typeof value.score === "object") {
    const nested = scoreObjectToText(value.score);
    if (nested) return nested;
  }

  return null;
}

function getObjectValue(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key];
      if (value !== null && value !== undefined && value !== "") {
        return value;
      }
    }
  }

  return undefined;
}

function teamLooksLike(item, teamName) {
  if (!item || typeof item !== "object" || !teamName) return false;

  const target = normalizeTeamText(teamName);
  if (!target) return false;

  const candidates = [
    item.team,
    item.team_name,
    item.name,
    item.batting_team,
    item.batting,
    item.side,
    item.label,
    item.title
  ];

  return candidates.some(value => {
    const normalized = normalizeTeamText(value);
    return normalized && (normalized === target || normalized.includes(target) || target.includes(normalized));
  });
}

function normalizeTeamText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findScoreInInnings(container, teamName) {
  if (!container || typeof container !== "object") return null;

  const arrays = [
    container.innings,
    container.innings_data,
    container.inningsData,
    container.scorecard,
    container.scores
  ];

  for (const array of arrays) {
    if (!Array.isArray(array)) continue;

    /* Prefer the inning belonging to the requested team. */
    for (const inning of array) {
      if (teamLooksLike(inning, teamName)) {
        const score = scoreObjectToText(inning);
        if (score) return score;
      }
    }

    /* Fall back to the first object that actually contains a cricket score. */
    for (const inning of array) {
      const score = scoreObjectToText(inning);
      if (score) return score;
    }
  }

  return null;
}

function extractTeamScore(container, match, side) {
  if (!container || typeof container !== "object") return null;

  const teamName =
    side === "home"
      ? (match?.home || container?.home || "")
      : (match?.away || container?.away || "");

  const directKeys =
    side === "home"
      ? ["home_score", "homeScore", "home_scorecard"]
      : ["away_score", "awayScore", "away_scorecard"];

  /* 1. Direct provider fields. */
  const direct = getObjectValue(container, directKeys);
  const directScore = scoreObjectToText(direct);
  if (directScore) return directScore;

  /* 2. score/scores wrappers. */
  for (const wrapperKey of ["score", "scores", "result", "scoreboard", "live_score", "liveScore"]) {
    const wrapper = container[wrapperKey];
    if (!wrapper || typeof wrapper !== "object") continue;

    const sideKeys =
      side === "home"
        ? ["home", "home_score", "homeScore", "team1", "team_1"]
        : ["away", "away_score", "awayScore", "team2", "team_2"];

    const value = getObjectValue(wrapper, sideKeys);
    const score = scoreObjectToText(value);
    if (score) return score;

    const inningsScore = findScoreInInnings(wrapper, teamName);
    if (inningsScore) return inningsScore;
  }

  /* 3. Nested team objects. */
  const teamObject = container[side];
  const teamScore = scoreObjectToText(teamObject);
  if (teamScore) return teamScore;

  if (teamObject && typeof teamObject === "object") {
    const nested = scoreObjectToText(teamObject.score);
    if (nested) return nested;
  }

  /* 4. Innings/scorecard arrays. */
  const inningsScore = findScoreInInnings(container, teamName);
  if (inningsScore) return inningsScore;

  return null;
}

function extractBattingTeam(container) {
  if (!container || typeof container !== "object") return null;

  const direct = getObjectValue(container, [
    "batting_team",
    "battingTeam",
    "batting",
    "current_batting_team"
  ]);

  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (direct && typeof direct === "object") {
    return getObjectValue(direct, ["name", "team", "title"]) || null;
  }

  for (const wrapperKey of ["score", "scores", "result", "scoreboard", "live_score", "liveScore"]) {
    const wrapper = container[wrapperKey];
    if (!wrapper || typeof wrapper !== "object") continue;
    const value = getObjectValue(wrapper, ["batting_team", "battingTeam", "batting"]);
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const name = getObjectValue(value, ["name", "team", "title"]);
      if (name) return String(name);
    }
  }

  return null;
}

function extractMatchOvers(container) {
  if (!container || typeof container !== "object") return null;

  const direct = getObjectValue(container, ["overs", "current_overs", "currentOvers"]);
  const directOvers = extractOvers(direct);
  if (directOvers !== null) return directOvers;

  for (const wrapperKey of ["score", "scores", "result", "scoreboard", "live_score", "liveScore"]) {
    const wrapper = container[wrapperKey];
    if (!wrapper || typeof wrapper !== "object") continue;
    const value = getObjectValue(wrapper, ["overs", "current_overs", "currentOvers"]);
    const overs = extractOvers(value);
    if (overs !== null) return overs;
  }

  return null;
}

/* =========================================================
   SCORE EXTRACTION
========================================================= */

function extractScore(
  value
) {
  return scoreObjectToText(value);
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
  competition = "",
  homeScore = null,
  awayScore = null,
  overs = null,
  battingTeam = null
) {

  /* Explicit provider status always wins. */
  if (
    isExplicitFinishedStatus(
      status,
      statusText
    )
  ) {
    return "Finished";
  }

  if (
    isExplicitLiveStatus(
      status,
      statusText
    )
  ) {
    return "Live";
  }

  /* A score/innings is stronger evidence than a vague list status. */
  if (
    hasLiveScoreEvidence(
      homeScore,
      awayScore,
      overs,
      battingTeam,
      statusText
    )
  ) {
    return "Live";
  }

  const startTime =
    getMatchStartTime(matchTime);

  if (!Number.isFinite(startTime)) {
    return "Upcoming";
  }

  const now = Date.now();

  /* Future fixtures are genuinely upcoming. */
  if (startTime > now) {
    return "Upcoming";
  }

  /*
   * We have a past-start match with no explicit status.  It must NOT
   * fall through to Upcoming.  If the individual endpoint was
   * temporarily unavailable, use a conservative format-aware fallback.
   * Limited-overs matches older than 6 hours are overwhelmingly likely
   * to be finished; first-class/Test matches remain Live until the
   * provider gives us a finished status.
   */
  const ageMs =
    now - startTime;

  const sixHours =
    6 * 60 * 60 * 1000;

  if (
    isLimitedOversCompetition(competition) &&
    ageMs >= sixHours
  ) {
    return "Finished";
  }

  /*
   * A match already past its scheduled start and still present in the
   * live/recent feed is not an Upcoming fixture.  Keep it visible as
   * Live rather than silently hiding/reclassifying it.
   */
  return "Live";

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

      const sourceStatus =
        normalizeSportScoreStatus(
          source.status,
          source.status_text,
          source.time,
          source.competition,
          extractTeamScore(source, source, "home"),
          extractTeamScore(source, source, "away"),
          extractOvers(source.overs),
          source.batting_team || null
        );

      if (
        sourceStatus === "Finished"
      ) {
        return json({
          score: null,
          error:
            "Match is no longer live.",
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
              extractTeamScore(
                details || source,
                source,
                "home"
              ) || extractTeamScore(source, source, "home"),
            away_score:
              extractTeamScore(
                details || source,
                source,
                "away"
              ) || extractTeamScore(source, source, "away"),
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
              extractTeamScore(source, source, "home"),
            away_score:
              extractTeamScore(source, source, "away"),
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
                  extractTeamScore(
                    details || match,
                    match,
                    "home"
                  ) || extractTeamScore(match, match, "home"),
                away_score:
                  extractTeamScore(
                    details || match,
                    match,
                    "away"
                  ) || extractTeamScore(match, match, "away"),
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
