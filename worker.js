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

    if (url.pathname === "/api/admin/me" && request.method === "GET") {
      return handleAdminMe(request, env);
    }

    if (url.pathname === "/api/admin/users" && request.method === "GET") {
      return handleAdminUsers(request, env);
    }

    if (url.pathname === "/api/admin/users" && request.method === "POST") {
      return handleCreateAdmin(request, env);
    }

    if (url.pathname === "/api/admin/users" && request.method === "DELETE") {
      return handleDeleteAdmin(request, env);
    }

    if (url.pathname === "/api/admin/audit" && request.method === "GET") {
      return handleAdminAudit(request, env);
    }

    if (url.pathname === "/api/admin/password-audit" && request.method === "POST") {
      return handlePasswordAudit(request, env);
    }

    return env.ASSETS.fetch(
      request
    );

  }
};


/* =========================================================
   MAIN CRICKET API
========================================================= */


/* =========================================================
   SECURE ADMIN MANAGEMENT
========================================================= */

const SUPABASE_PROJECT_URL =
  "https://qkzwzdyahwzcwtqgcbud.supabase.co";

function getBearerToken(request) {
  const value = request.headers.get("Authorization") || "";
  return value.startsWith("Bearer ")
    ? value.slice(7).trim()
    : "";
}

async function requireOwner(request, env) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return {
      ok: false,
      response: json(
        { error: "Server authentication is not configured." },
        500
      )
    };
  }

  const token = getBearerToken(request);

  if (!token) {
    return {
      ok: false,
      response: json(
        { error: "Authentication required." },
        401
      )
    };
  }

  const userResponse = await fetch(
    `${SUPABASE_PROJECT_URL}/auth/v1/user`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (!userResponse.ok) {
    return {
      ok: false,
      response: json(
        { error: "Authentication required." },
        401
      )
    };
  }

  const user = await userResponse.json();

  if (!user?.id) {
    return {
      ok: false,
      response: json(
        { error: "Invalid authenticated user." },
        401
      )
    };
  }

  const ownerResponse = await supabaseAdminFetch(
    env,
    `/rest/v1/admin_users?select=user_id,role&user_id=eq.${encodeURIComponent(
      user.id
    )}&role=eq.owner&limit=1`
  );

  if (!ownerResponse.ok) {
    return {
      ok: false,
      response: await supabaseErrorResponse(ownerResponse)
    };
  }

  const owners = await ownerResponse.json();

  if (!owners.length) {
    return {
      ok: false,
      response: json(
        { error: "Owner access required." },
        403
      )
    };
  }

  return { ok: true, user };
}

async function requireAdmin(request, env) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return {
      ok: false,
      response: json(
        { error: "Server authentication is not configured." },
        500
      )
    };
  }

  const token = getBearerToken(request);

  if (!token) {
    return {
      ok: false,
      response: json(
        { error: "Authentication required." },
        401
      )
    };
  }

  const userResponse = await fetch(
    `${SUPABASE_PROJECT_URL}/auth/v1/user`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (!userResponse.ok) {
    return {
      ok: false,
      response: json(
        { error: "Authentication required." },
        401
      )
    };
  }

  const user = await userResponse.json();

  const adminResponse = await supabaseAdminFetch(
    env,
    `/rest/v1/admin_users?select=user_id,role&user_id=eq.${encodeURIComponent(
      user.id
    )}&limit=1`
  );

  if (!adminResponse.ok) {
    return {
      ok: false,
      response: await supabaseErrorResponse(adminResponse)
    };
  }

  const admins = await adminResponse.json();

  if (!admins.length) {
    return {
      ok: false,
      response: json(
        { error: "Administrator access required." },
        403
      )
    };
  }

  return { ok: true, user };
}

async function supabaseAdminFetch(env, path, options = {}) {
  return fetch(`${SUPABASE_PROJECT_URL}${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization:
        `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
}

async function supabaseErrorResponse(response) {
  const data = await response
    .json()
    .catch(() => ({}));

  return json(
    {
      error:
        data?.message ||
        data?.details ||
        data?.hint ||
        "Database request failed."
    },
    response.status || 500
  );
}

async function handleAdminMe(request, env) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const response = await supabaseAdminFetch(env, `/rest/v1/admin_users?select=user_id,role,display_name,email,created_at&user_id=eq.${encodeURIComponent(auth.user.id)}&limit=1`);
  if (!response.ok) return supabaseErrorResponse(response);
  const rows = await response.json();
  if (!rows.length) return json({ error: "Administrator access required." }, 403);
  return json(rows[0]);
}

async function handleAdminAudit(request, env) {
  const auth = await requireOwner(request, env);
  if (!auth.ok) return auth.response;
  const response = await supabaseAdminFetch(env, "/rest/v1/admin_audit_log?select=*&order=created_at.desc&limit=500");
  if (!response.ok) return supabaseErrorResponse(response);
  const audit = await response.json();
  const usersResponse = await supabaseAdminFetch(env, "/rest/v1/admin_users?select=user_id,display_name,email,role");
  if (!usersResponse.ok) return supabaseErrorResponse(usersResponse);
  const users = await usersResponse.json();
  const identities = Object.fromEntries((users || []).map(u => [u.user_id, u]));
  return json((audit || []).map(entry => ({ ...entry, actor: identities[entry.actor_user_id] || null })));
}

async function handleAdminUsers(request, env) {
  const auth = await requireOwner(request, env);

  if (!auth.ok) return auth.response;

  const response = await supabaseAdminFetch(
    env,
    "/rest/v1/admin_users" +
      "?select=user_id,role,display_name,email,created_at" +
      "&order=created_at.asc"
  );

  if (!response.ok) {
    return supabaseErrorResponse(response);
  }

  return json(await response.json());
}

async function handleCreateAdmin(request, env) {
  const auth = await requireOwner(request, env);

  if (!auth.ok) return auth.response;

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  const displayName =
    String(body?.display_name || "").trim();

  const email =
    String(body?.email || "")
      .trim()
      .toLowerCase();

  const password =
    String(body?.password || "");

  if (displayName.length < 2 || displayName.length > 80) {
    return json(
      { error: "Name must be between 2 and 80 characters." },
      400
    );
  }

  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return json(
      { error: "Enter a valid email address." },
      400
    );
  }

  if (password.length < 12 || password.length > 128) {
    return json(
      {
        error:
          "Initial password must be between 12 and 128 characters."
      },
      400
    );
  }

  const existingAdmin =
    await supabaseAdminFetch(
      env,
      `/rest/v1/admin_users?select=user_id` +
        `&email=eq.${encodeURIComponent(email)}` +
        `&limit=1`
    );

  if (!existingAdmin.ok) {
    return supabaseErrorResponse(existingAdmin);
  }

  if ((await existingAdmin.json()).length) {
    return json(
      { error: "That email is already a Cricketive administrator." },
      409
    );
  }

  const authResponse = await fetch(
    `${SUPABASE_PROJECT_URL}/auth/v1/admin/users`,
    {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization:
          `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          display_name: displayName
        }
      })
    }
  );

  const authData =
    await authResponse.json().catch(() => ({}));

  if (!authResponse.ok) {
    return json(
      {
        error:
          authData?.msg ||
          authData?.message ||
          "Unable to create the account."
      },
      authResponse.status === 422 ? 409 : 502
    );
  }

  const userId = authData?.id;

  if (!userId) {
    return json(
      { error: "Supabase Auth did not return a user ID." },
      502
    );
  }

  const adminResponse =
    await supabaseAdminFetch(
      env,
      "/rest/v1/admin_users",
      {
        method: "POST",
        headers: {
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          user_id: userId,
          role: "admin",
          display_name: displayName,
          email
        })
      }
    );

  if (!adminResponse.ok) {
    await fetch(
      `${SUPABASE_PROJECT_URL}/auth/v1/admin/users/${encodeURIComponent(
        userId
      )}`,
      {
        method: "DELETE",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    ).catch(() => {});

    return supabaseErrorResponse(adminResponse);
  }

  const created =
    (await adminResponse.json())[0];

  await writeAdminAudit(env, {
    actor_user_id: auth.user.id,
    actor_type: "admin",
    action: "INSERT",
    table_name: "admin_users",
    record_id: userId,
    old_data: null,
    new_data: {
      user_id: userId,
      role: "admin",
      display_name: displayName,
      email
    }
  });

  return json(
    {
      user: {
        user_id: created.user_id,
        role: created.role,
        display_name: created.display_name,
        email: created.email,
        created_at: created.created_at
      }
    },
    201
  );
}

async function handleDeleteAdmin(request, env) {
  const auth = await requireOwner(request, env);

  if (!auth.ok) return auth.response;

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  const userId =
    String(body?.user_id || "").trim();

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!uuidPattern.test(userId)) {
    return json({ error: "Invalid administrator ID." }, 400);
  }

  if (userId === auth.user.id) {
    return json(
      { error: "The owner account cannot be removed." },
      403
    );
  }

  const lookup =
    await supabaseAdminFetch(
      env,
      `/rest/v1/admin_users?select=user_id,role,display_name,email,created_at` +
        `&user_id=eq.${encodeURIComponent(userId)}` +
        `&limit=1`
    );

  if (!lookup.ok) {
    return supabaseErrorResponse(lookup);
  }

  const rows = await lookup.json();

  if (!rows.length) {
    return json({ error: "Administrator not found." }, 404);
  }

  const admin = rows[0];

  if (admin.role === "owner") {
    return json(
      { error: "The owner account cannot be removed." },
      403
    );
  }

  const dbDelete =
    await supabaseAdminFetch(
      env,
      `/rest/v1/admin_users?user_id=eq.${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    );

  if (!dbDelete.ok) {
    return supabaseErrorResponse(dbDelete);
  }

  await writeAdminAudit(env, {
    actor_user_id: auth.user.id,
    actor_type: "admin",
    action: "DELETE",
    table_name: "admin_users",
    record_id: userId,
    old_data: admin,
    new_data: null
  });

  const authDelete =
    await fetch(
      `${SUPABASE_PROJECT_URL}/auth/v1/admin/users/${encodeURIComponent(
        userId
      )}`,
      {
        method: "DELETE",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );

  if (!authDelete.ok && authDelete.status !== 404) {
    return json(
      {
        error:
          "Administrator access was revoked, but the Auth account could not be cleaned up."
      },
      502
    );
  }

  return json({ ok: true });
}

async function handlePasswordAudit(request, env) {
  const auth = await requireAdmin(request, env);

  if (!auth.ok) return auth.response;

  await writeAdminAudit(env, {
    actor_user_id: auth.user.id,
    actor_type: "admin",
    action: "UPDATE",
    table_name: "auth.users",
    record_id: auth.user.id,
    old_data: { event: "password_change" },
    new_data: { event: "password_change" }
  });

  return json({ ok: true });
}

async function writeAdminAudit(env, entry) {
  return supabaseAdminFetch(
    env,
    "/rest/v1/admin_audit_log",
    {
      method: "POST",
      headers: {
        Prefer: "return=minimal"
      },
      body: JSON.stringify(entry)
    }
  );
}

async function handleCricketAPI() {

  try {

    /*
     * -----------------------------------------------------
     * GET MATCH LIST
     * -----------------------------------------------------
     */

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


              status_source:
                "sportscore-match-list",


              provider_status:
                match.status || null,


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

      live_count:
        normalized.filter(
          match => match.status === "Live"
        ).length,

      upcoming_count:
        normalized.filter(
          match => match.status === "Upcoming"
        ).length,

      finished_count:
        normalized.filter(
          match => match.status === "Finished"
        ).length,

      unknown_count:
        normalized.filter(
          match => match.status === "Unknown"
        ).length,

      status_authority:
        "sportscore-match-list",

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
  const value = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");

  const text = String(statusText || "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");

  const liveStates = new Set([
    "live",
    "in_progress",
    "inprogress",
    "inplay",
    "in_play",
    "started",
    "playing",
    "ongoing",
    "innings",
    "1st_inn",
    "2nd_inn",
    "3rd_inn",
    "4th_inn",
    "batting"
  ]);

  return (
    liveStates.has(value) ||
    liveStates.has(text) ||
    text.includes("innings") ||
    text.includes("in_progress") ||
    text.includes("inplay")
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
  /*
   * SportScore is the authoritative status source.
   *
   * IMPORTANT:
   * - Do not infer LIVE from match time.
   * - Do not infer FINISHED from match time.
   * - Do not infer status from score, innings or batting team.
   * - Only normalize the explicit SportScore status/status_text.
   */

  const value = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");

  const text = String(statusText || "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");

  const liveStates = new Set([
    "live",
    "in_progress",
    "inprogress",
    "inplay",
    "in_play",
    "started",
    "playing",
    "ongoing",
    "innings",
    "1st_inn",
    "2nd_inn",
    "3rd_inn",
    "4th_inn",
    "batting"
  ]);

  if (
    liveStates.has(value) ||
    liveStates.has(text) ||
    text.includes("innings") ||
    text.includes("in_progress") ||
    text.includes("inplay")
  ) {
    return "Live";
  }

  const finishedStates = new Set([
    "finished",
    "finish",
    "ended",
    "end",
    "completed",
    "complete",
    "ft",
    "full_time",
    "fulltime",
    "after_match",
    "post_match",
    "postmatch"
  ]);

  if (
    finishedStates.has(value) ||
    finishedStates.has(text) ||
    text.includes("match_finished") ||
    text.includes("match_ended") ||
    text.includes("won_by")
  ) {
    return "Finished";
  }

  const upcomingStates = new Set([
    "scheduled",
    "upcoming",
    "not_started",
    "notstarted",
    "pre_match",
    "prematch",
    "pending",
    "ns",
    "not_started_yet"
  ]);

  if (
    upcomingStates.has(value) ||
    upcomingStates.has(text)
  ) {
    return "Upcoming";
  }

  const closedStates = new Set([
    "cancelled",
    "canceled",
    "abandoned"
  ]);

  if (
    closedStates.has(value) ||
    closedStates.has(text)
  ) {
    return "Finished";
  }

  /*
   * Unknown provider state stays Unknown.
   * Never guess based on matchTime.
   */
  return "Unknown";
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
          "no-store, no-cache, must-revalidate, max-age=0",

        "access-control-allow-origin":
          "*"

      }

    }
  );

}
