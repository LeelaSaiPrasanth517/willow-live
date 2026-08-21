/* =========================================================
   Cricketive Worker v8
   Status authority: SportScore cricket match-list endpoint.
   Individual match endpoints are enrichment-only (scores, overs,
   batting team, logos, etc.) and MUST NOT override match status.
========================================================= */

const SPORTSCORE_MATCHES_URL =
  "https://sportscore.com/api/widget/matches/?sport=cricket&limit=50&src=cricketive";

const DETAIL_CONCURRENCY = 5;
const MAX_DETAIL_LOOKUPS = 15;
const FEED_STALE_MS = 5 * 60 * 1000;

let lastSuccessfulFeed = null;
let lastSuccessfulFeedAt = 0;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/cricket-matches") {
      return handleCricketMatches();
    }

    if (url.pathname === "/api/live-scores") {
      return handleLiveScores(request);
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

    if (url.pathname === "/api/admin/password-audit" && request.method === "POST") {
      return handlePasswordAudit(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};


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


/* =========================================================
   FETCH / RESILIENCE
========================================================= */

async function fetchWithRetry(url, options = {}, attempts = 3, timeoutMs = 8000) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      if (response.ok) return response;

      lastError = new Error(`HTTP ${response.status}`);

      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }

    if (attempt < attempts) {
      await new Promise(resolve =>
        setTimeout(resolve, 250 * Math.pow(2, attempt - 1))
      );
    }
  }

  throw lastError || new Error("Request failed.");
}

async function fetchJsonWithRetry(url, options = {}, attempts = 3, timeoutMs = 8000) {
  const response = await fetchWithRetry(url, options, attempts, timeoutMs);
  return response.json();
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );

  return results;
}

/* =========================================================
   MAIN MATCH FEED
========================================================= */

async function handleCricketMatches() {
  try {
    const payload = await fetchJsonWithRetry(
      SPORTSCORE_MATCHES_URL,
      {
        cf: {
          cacheTtl: 60,
          cacheEverything: true
        }
      },
      3,
      8000
    );

    const matches = Array.isArray(payload?.matches) ? payload.matches : [];

    /*
     * The list endpoint is the first source of truth.
     * Individual details are fetched only for ambiguous/in-play candidates.
     * We NEVER infer LIVE from score, innings, batting team, or elapsed time.
     */
    const candidates = matches
      .map((match, index) => ({ match, index, priority: detailPriority(match) }))
      .filter(item => item.priority > 0)
      .sort((a, b) => b.priority - a.priority)
      .slice(0, MAX_DETAIL_LOOKUPS);

    const detailMap = new Map();

    const detailResults = await mapWithConcurrency(
      candidates,
      DETAIL_CONCURRENCY,
      async item => {
        try {
          if (!item.match?.url) return { index: item.index, details: null };
          const details = await getIndividualMatch(item.match.url);
          return { index: item.index, details };
        } catch (error) {
          console.warn("SportScore detail lookup failed:", item.match?.url, error?.message || error);
          return { index: item.index, details: null };
        }
      }
    );

    for (const item of detailResults) {
      if (item?.details) detailMap.set(item.index, item.details);
    }

    const normalized = matches.map((match, index) => {
      const details = detailMap.get(index);
      return normalizeMatch(match, details);
    });

    const result = {
      sport: "cricket",
      count: normalized.length,
      live_count: normalized.filter(m => m.status === "Live").length,
      updated: payload?.updated || new Date().toISOString(),
      matches: normalized,
      stale: false,
      source: "sportscore-api"
    };

    lastSuccessfulFeed = result;
    lastSuccessfulFeedAt = Date.now();

    return json(result);
  } catch (error) {
    console.error("Cricketive match feed error:", error);

    if (
      lastSuccessfulFeed &&
      Date.now() - lastSuccessfulFeedAt <= FEED_STALE_MS
    ) {
      return json({
        ...lastSuccessfulFeed,
        stale: true,
        stale_reason: "SportScore temporarily unavailable; showing the last successful feed."
      });
    }

    return json(
      {
        error: error?.message || "Unable to load cricket matches.",
        source: "sportscore-api"
      },
      503
    );
  }
}

function normalizeMatch(match, details) {
  const base = isObject(match) ? match : {};
  const detail = isObject(details) ? details : {};

  // IMPORTANT: status comes ONLY from the SportScore LIST record.
  // The individual match endpoint is enrichment-only and must never
  // promote an Upcoming/unknown match to Live.
  const providerStatus = getProviderStatus(base);
  const statusText = getProviderStatusText(base) ?? "";
  const resolvedStatus = normalizeSportScoreStatus(
    providerStatus,
    statusText,
    base.time ?? detail.time ?? null,
    true
  );

  const home = cleanTeamName(base.home ?? detail.home);
  const away = cleanTeamName(base.away ?? detail.away);

  // FIX: prefer the LIST record first, not the detail record.
  // Confirmed against SportScore's live widget response: the list
  // endpoint already returns clean flat "home_score"/"away_score"
  // strings like "145/5" directly on each match object. That's a
  // known-good, verified shape. The individual /match/ detail
  // endpoint's shape is not verified against live data, so it's kept
  // only as a fallback for whatever the list doesn't have (e.g. if a
  // future SportScore change adds richer batting/overs detail there).
  let homeScore = extractTeamScore(base, { home, away }, "home");
  let awayScore = extractTeamScore(base, { home, away }, "away");

  if (!isRealScore(homeScore)) {
    homeScore = extractTeamScore(detail, { home, away }, "home");
  }
  if (!isRealScore(awayScore)) {
    awayScore = extractTeamScore(detail, { home, away }, "away");
  }

  const battingTeam =
    extractBattingTeam(detail) ||
    extractBattingTeam(base) ||
    null;

  const overs =
    extractMatchOvers(detail) ??
    extractMatchOvers(base);

  return {
    home,
    away,
    home_logo: base.home_logo || detail.home_logo || "",
    away_logo: base.away_logo || detail.away_logo || "",
    home_score: homeScore,
    away_score: awayScore,
    status: resolvedStatus.status,
    status_confidence: resolvedStatus.confidence,
    status_text: statusText,
    batting_team: battingTeam,
    overs,
    time: base.time ?? detail.time ?? null,
    competition: base.competition || detail.competition || "Cricket",
    competition_logo:
      base.competition_logo || detail.competition_logo || "",
    url: base.url || detail.url || "",
    score: base.score || base.scores || detail.score || detail.scores || null,
    live_minute: base.live_minute || detail.live_minute || null
  };
}

/* =========================================================
   DETAIL CANDIDATES
========================================================= */

function detailPriority(match) {
  if (!match || !match.url) return 0;

  const status = getProviderStatus(match);
  const statusText = getProviderStatusText(match) || "";

  if (isExplicitFinishedStatus(status, statusText)) return 0;

  if (isExplicitLiveStatus(status, statusText)) return 100;

  const normalizedText = normalizeStatusValue(statusText);
  if (
    normalizedText.includes("1st_inn") ||
    normalizedText.includes("2nd_inn") ||
    normalizedText.includes("innings") ||
    normalizedText.includes("batting") ||
    normalizedText === "live" ||
    normalizedText === "started" ||
    normalizedText === "in_progress" ||
    normalizedText === "inplay" ||
    normalizedText === "in_play"
  ) {
    return 90;
  }

  const start = getMatchStartTime(match.time || match.start_time || match.match_time);
  if (Number.isFinite(start)) {
    const delta = Date.now() - start;
    if (delta >= -30 * 60 * 1000 && delta <= 3 * 60 * 60 * 1000) {
      return 60;
    }
  }

  return 0;
}

/* =========================================================
   INDIVIDUAL SPORTScore MATCH
========================================================= */

async function getIndividualMatch(matchUrl) {
  const slug = extractSlug(matchUrl);
  if (!slug) throw new Error("Could not extract SportScore match slug.");

  const apiUrl =
    "https://sportscore.com/api/widget/match/" +
    `?sport=cricket&slug=${encodeURIComponent(slug)}&src=cricketive`;

  const payload = await fetchJsonWithRetry(
    apiUrl,
    {
      cf: {
        cacheTtl: 60,
        cacheEverything: true
      }
    },
    2,
    7000
  );

  if (payload?.match && isObject(payload.match)) return payload.match;
  if (payload?.data?.match && isObject(payload.data.match)) return payload.data.match;
  if (payload?.data && isObject(payload.data)) return payload.data;
  if (payload && isObject(payload)) return payload;

  return null;
}

function extractSlug(value) {
  if (!value) return null;
  let url = String(value).trim().split("?")[0].replace(/\/+$/, "");
  const parts = url.split("/");
  const slug = parts[parts.length - 1];
  return slug && slug !== "match" ? slug : null;
}

/* =========================================================
   STATUS
========================================================= */

function getProviderStatus(obj) {
  if (!isObject(obj)) return null;

  const values = [
    obj.status,
    obj.state,
    obj.match_status,
    obj.matchStatus,
    obj.live_status,
    obj.liveStatus
  ];

  for (const value of values) {
    if (typeof value === "boolean") return value ? "live" : "scheduled";
    if (value !== null && value !== undefined && String(value).trim()) {
      return String(value).trim();
    }
  }

  return null;
}

function getProviderStatusText(obj) {
  if (!isObject(obj)) return null;

  const values = [
    obj.status_text,
    obj.statusText,
    obj.match_status_text,
    obj.matchStatusText,
    obj.state_text,
    obj.stateText
  ];

  for (const value of values) {
    if (value !== null && value !== undefined && String(value).trim()) {
      return String(value).trim();
    }
  }

  return null;
}

function normalizeStatusValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
}

function isExplicitFinishedStatus(status, statusText = "") {
  const value = normalizeStatusValue(status);
  const text = normalizeStatusValue(statusText);

  return [
    "finished",
    "finish",
    "ended",
    "end",
    "completed",
    "complete",
    "ft",
    "full_time",
    "fulltime",
    "after_match"
  ].includes(value) || [
    "finished",
    "ended",
    "completed",
    "complete"
  ].includes(text) ||
    text.includes("match_finished") ||
    text.includes("match_ended") ||
    text.includes("won_by");
}

function isExplicitLiveStatus(status, statusText = "") {
  const value = normalizeStatusValue(status);
  const text = normalizeStatusValue(statusText);

  return [
    "live",
    "in_progress",
    "started",
    "playing",
    "ongoing",
    "inplay",
    "in_play",
    "1st_inn",
    "2nd_inn"
  ].includes(value) || [
    "live",
    "in_progress",
    "started",
    "playing",
    "ongoing",
    "inplay",
    "in_play",
    "1st_inn",
    "2nd_inn"
  ].includes(text);
}

function isExplicitNonLiveStatus(status, statusText = "") {
  const value = normalizeStatusValue(status);
  const text = normalizeStatusValue(statusText);

  return [
    "scheduled",
    "upcoming",
    "not_started",
    "notstarted",
    "pre_match",
    "prematch",
    "postponed",
    "delayed",
    "cancelled",
    "canceled",
    "abandoned"
  ].includes(value) || [
    "scheduled",
    "upcoming",
    "not_started",
    "notstarted",
    "pre_match",
    "prematch",
    "postponed",
    "delayed",
    "cancelled",
    "canceled",
    "abandoned"
  ].includes(text);
}

function normalizeSportScoreStatus(status, statusText = "", matchTime = null, withConfidence = false) {
  const start = getMatchStartTime(matchTime);
  const result = (value, confidence) => withConfidence ? { status: value, confidence } : value;

  /* A future fixture can never be live, even if a provider payload is
     contradictory. */
  if (Number.isFinite(start) && start > Date.now()) {
    return result("Upcoming", "confirmed");
  }

  /* Explicit terminal state wins. */
  if (isExplicitFinishedStatus(status, statusText)) return result("Finished", "confirmed");

  /* Live is accepted ONLY from the SportScore list record. */
  if (isStrongLiveStatus(status, statusText)) return result("Live", "confirmed");

  /* A past match must NEVER be rendered as Upcoming. If SportScore still
     reports Scheduled/Upcoming after the scheduled time (this genuinely
     happens — SportScore sometimes leaves status_text: "Abnormal" on a
     record whose status never flips), treat the record as non-live/closed
     for the public feed rather than inventing LIVE. This branch is a
     best-effort guess, not a confirmed provider signal, hence "inferred" —
     Admin can use that flag to flag these rows for a human to check. */
  if (Number.isFinite(start) && start <= Date.now()) {
    return result("Finished", "inferred");
  }

  if (isExplicitNonLiveStatus(status, statusText)) return result("Upcoming", "confirmed");

  /* Conservative fallback: never manufacture LIVE. */
  return result("Upcoming", "unknown");
}

function isStrongLiveStatus(status, statusText = "") {
  const value = normalizeStatusValue(status);
  const text = normalizeStatusValue(statusText);
  return (
    ["live", "in_progress", "inplay", "in_play"].includes(value) ||
    ["live", "in_progress", "inplay", "in_play"].includes(text)
  );
}

function getMatchStartTime(value) {
  if (!value) return NaN;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : NaN;
}

/* =========================================================
   SCORE EXTRACTION
========================================================= */

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanTeamName(value) {
  return String(value || "").trim();
}

function normalizeTeamText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isScoreString(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return /^\d+(?:\/\d+)?(?:\s*\([^)]*\))?$/.test(text) ||
    /\b\d+\/\d+\b/.test(text);
}

function scoreObjectToText(value) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return isScoreString(text) ? text.match(/\b\d+(?:\/\d+)(?:\s*\([^)]*\))?\b/)?.[0] || text : null;
  }

  if (!isObject(value)) return null;

  const runs = value.runs ?? value.run ?? value.total_runs ?? value.total ?? value.points ?? null;
  const wickets = value.wickets ?? value.wicket ?? value.outs ?? value.dismissals ?? null;

  if (runs !== null && runs !== undefined && runs !== "") {
    const r = String(runs).trim();
    if (isScoreString(r) && wickets === null) return r;
    if (/^\d+$/.test(r)) {
      if (wickets !== null && wickets !== undefined && /^\d+$/.test(String(wickets).trim())) {
        return `${r}/${String(wickets).trim()}`;
      }
      return r;
    }
  }

  if (value.score !== undefined) {
    const nested = scoreObjectToText(value.score);
    if (nested) return nested;
  }

  return null;
}

function getObjectValue(obj, keys) {
  if (!isObject(obj)) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key];
      if (value !== null && value !== undefined && value !== "") return value;
    }
  }
  return undefined;
}

function teamLooksLike(item, teamName) {
  if (!isObject(item) || !teamName) return false;
  const target = normalizeTeamText(teamName);
  if (!target) return false;

  const candidates = [
    item.team,
    item.team_name,
    item.teamName,
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

function deepFindTeamScore(container, teamName, depth = 0) {
  if (!container || depth > 6) return null;

  if (Array.isArray(container)) {
    for (const item of container) {
      const result = deepFindTeamScore(item, teamName, depth + 1);
      if (result) return result;
    }
    return null;
  }

  if (!isObject(container)) return null;

  if (teamLooksLike(container, teamName)) {
    const direct = scoreObjectToText(container.score ?? container.runs ?? container.total ?? container.scorecard);
    if (direct) return direct;
  }

  for (const [key, value] of Object.entries(container)) {
    if (["home", "away", "home_team", "away_team"].includes(key)) continue;
    if (value && typeof value === "object") {
      const result = deepFindTeamScore(value, teamName, depth + 1);
      if (result) return result;
    }
  }

  return null;
}

function findScoreInInnings(container, teamName, side) {
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

    for (const inning of array) {
      if (teamLooksLike(inning, teamName)) {
        const score = scoreObjectToText(inning);
        if (score) return score;
      }
    }
  }

  return deepFindTeamScore(container, teamName);
}

function extractTeamScore(container, match, side) {
  if (!container || typeof container !== "object") return null;

  const teamName = side === "home" ? match?.home || "" : match?.away || "";

  const directKeys = side === "home"
    ? ["home_score", "homeScore", "home_scorecard"]
    : ["away_score", "awayScore", "away_scorecard"];

  const direct = getObjectValue(container, directKeys);
  const directScore = scoreObjectToText(direct);
  if (directScore) return directScore;

  for (const wrapperKey of ["score", "scores", "result", "scoreboard", "live_score", "liveScore"]) {
    const wrapper = container[wrapperKey];
    if (!wrapper || typeof wrapper !== "object") continue;

    const sideKeys = side === "home"
      ? ["home", "home_score", "homeScore", "team1", "team_1"]
      : ["away", "away_score", "awayScore", "team2", "team_2"];

    const value = getObjectValue(wrapper, sideKeys);
    const score = scoreObjectToText(value);
    if (score) return score;

    const inningsScore = findScoreInInnings(wrapper, teamName, side);
    if (inningsScore) return inningsScore;
  }

  const teamObject = container[side];
  const teamScore = scoreObjectToText(teamObject);
  if (teamScore) return teamScore;

  if (teamObject && typeof teamObject === "object") {
    const nested = scoreObjectToText(teamObject.score);
    if (nested) return nested;
  }

  return findScoreInInnings(container, teamName, side);
}

function extractBattingTeam(container) {
  if (!container || typeof container !== "object") return null;

  const direct = getObjectValue(container, [
    "batting_team",
    "battingTeam",
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

function isRealScore(value) {
  if (value === null || value === undefined || value === "" || value === "-" || value === "—") return false;
  return isScoreString(value);
}

function extractOvers(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object") return value.current ?? value.total ?? value.overs ?? null;
  return null;
}

/* =========================================================
   LIVE SCORES ENDPOINT
========================================================= */

async function handleLiveScores(request) {
  try {
    const requestUrl = new URL(request.url);
    const requestedSource = requestUrl.searchParams.get("url") || "";

    const payload = await fetchJsonWithRetry(
      SPORTSCORE_MATCHES_URL,
      {
        cf: {
          cacheTtl: 60,
          cacheEverything: true
        }
      },
      3,
      8000
    );

    const matches = Array.isArray(payload?.matches) ? payload.matches : [];

    if (requestedSource) {
      const normalizedRequested = normalizeUrl(requestedSource);
      const source = matches.find(match => normalizeUrl(match.url) === normalizedRequested);

      if (!source) {
        return json({ score: null, error: "Match not found in the current SportScore feed.", updated: new Date().toISOString() });
      }

      const listStatus = getProviderStatus(source);
      const listStatusText = getProviderStatusText(source) || "";

      try {
        const details = await getIndividualMatch(source.url);
        // Detail is enrichment-only. Status remains the SportScore LIST status.
        const status = normalizeSportScoreStatus(listStatus, listStatusText, source.time);

        return json({
          score: {
            home: cleanTeamName(source.home || details?.home),
            away: cleanTeamName(source.away || details?.away),
            // FIX: try the verified list-record shape (source) first,
            // detail endpoint only as fallback — see normalizeMatch().
            home_score: extractTeamScore(source, source, "home") || extractTeamScore(details, source, "home"),
            away_score: extractTeamScore(source, source, "away") || extractTeamScore(details, source, "away"),
            status,
            status_text: listStatusText,
            batting_team: extractBattingTeam(details) || extractBattingTeam(source),
            overs: extractMatchOvers(details) ?? extractMatchOvers(source),
            time: source.time || details?.time || null
          },
          updated: new Date().toISOString()
        });
      } catch (error) {
        return json({
          score: {
            home: cleanTeamName(source.home),
            away: cleanTeamName(source.away),
            home_score: extractTeamScore(source, source, "home"),
            away_score: extractTeamScore(source, source, "away"),
            status: normalizeSportScoreStatus(listStatus, listStatusText, source.time, false),
            status_text: listStatusText,
            batting_team: extractBattingTeam(source),
            overs: extractMatchOvers(source),
            time: source.time || null
          },
          stale: true,
          stale_reason: "Individual score endpoint temporarily unavailable.",
          updated: new Date().toISOString()
        });
      }
    }

    const candidates = matches
      .map((match, index) => ({ match, index, priority: detailPriority(match) }))
      .filter(item => item.priority > 0 && isExplicitLiveStatus(getProviderStatus(item.match), getProviderStatusText(item.match)))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, MAX_DETAIL_LOOKUPS);

    const rows = await mapWithConcurrency(candidates, DETAIL_CONCURRENCY, async item => {
      try {
        const details = await getIndividualMatch(item.match.url);
        // Detail is enrichment-only. Status remains the SportScore LIST status.
        const status = normalizeSportScoreStatus(
          getProviderStatus(item.match),
          getProviderStatusText(item.match) ?? "",
          item.match.time
        );
        if (status !== "Live") return null;

        return {
          key: normalizeUrl(item.match.url),
          score: {
            home: cleanTeamName(item.match.home || details?.home),
            away: cleanTeamName(item.match.away || details?.away),
            // FIX: same ordering fix — verified list record first.
            home_score: extractTeamScore(item.match, item.match, "home") || extractTeamScore(details, item.match, "home"),
            away_score: extractTeamScore(item.match, item.match, "away") || extractTeamScore(details, item.match, "away"),
            status,
            status_text: getProviderStatusText(item.match) ?? "",
            batting_team: extractBattingTeam(details) || extractBattingTeam(item.match),
            overs: extractMatchOvers(details) ?? extractMatchOvers(item.match),
            time: item.match.time || details?.time || null
          }
        };
      } catch (error) {
        console.warn("Live score lookup failed:", item.match.url, error?.message || error);
        return null;
      }
    });

    const scores = {};
    for (const row of rows) {
      if (row?.key) scores[row.key] = row.score;
    }

    return json({ scores, updated: new Date().toISOString() });
  } catch (error) {
    return json({ scores: {}, error: error?.message || "Live score request failed.", updated: new Date().toISOString() }, 200);
  }
}

function normalizeUrl(value) {
  if (!value) return "";
  const url = String(value).trim();
  if (url.startsWith("http")) return url.replace(/\/+$/, "");
  return ("https://sportscore.com" + (url.startsWith("/") ? url : `/${url}`)).replace(/\/+$/, "");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=5",
      "access-control-allow-origin": "*"
    }
  });
}
