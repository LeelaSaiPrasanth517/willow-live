// ============================================================
// COMBINED WORKER – CRICKETIVE
// ============================================================

const SUPABASE_PROJECT_URL = "https://qkzwzdyahwzcwtqgcbud.supabase.co";

// ------------------- Helpers --------------------------------
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      ...extraHeaders,
    },
  });
}

function getBearerToken(request) {
  const value = request.headers.get("Authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

// ------------------- Supabase Admin Fetch -------------------
async function supabaseAdminFetch(env, path, options = {}) {
  return fetch(`${SUPABASE_PROJECT_URL}${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

async function supabaseErrorResponse(response) {
  const data = await response.json().catch(() => ({}));
  return json(
    {
      error:
        data?.message || data?.details || data?.hint || "Database request failed.",
    },
    response.status || 500,
  );
}

// ------------------- Auth / Admin Helpers -------------------
async function getAuthenticatedUser(request, env) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return {
      ok: false,
      response: json({ error: "Server authentication is not configured." }, 500),
    };
  }
  const token = getBearerToken(request);
  if (!token) {
    return { ok: false, response: json({ error: "Authentication required." }, 401) };
  }
  const resp = await fetch(`${SUPABASE_PROJECT_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!resp.ok) {
    return { ok: false, response: json({ error: "Invalid or expired session." }, 401) };
  }
  const user = await resp.json();
  if (!user?.id) {
    return { ok: false, response: json({ error: "Invalid user." }, 401) };
  }
  return { ok: true, user };
}

async function requireAdmin(request, env) {
  const auth = await getAuthenticatedUser(request, env);
  if (!auth.ok) return auth;
  const resp = await supabaseAdminFetch(
    env,
    `/rest/v1/admin_users?select=user_id,role,display_name,email,created_at&user_id=eq.${encodeURIComponent(auth.user.id)}&limit=1`,
  );
  if (!resp.ok) {
    return { ok: false, response: await supabaseErrorResponse(resp) };
  }
  const admins = await resp.json();
  if (!admins.length) {
    return { ok: false, response: json({ error: "Administrator access required." }, 403) };
  }
  return { ok: true, user: auth.user, admin: admins[0] };
}

async function requireOwner(request, env) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth;
  if (auth.admin.role !== "owner") {
    return { ok: false, response: json({ error: "Owner access required." }, 403) };
  }
  return auth;
}

async function writeAdminAudit(env, entry) {
  return supabaseAdminFetch(env, "/rest/v1/admin_audit_log", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(entry),
  });
}

// ------------------- Admin Endpoints ------------------------
async function handleAdminMe(request, env) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  return json({
    user_id: auth.admin.user_id,
    role: auth.admin.role,
    display_name: auth.admin.display_name,
    email: auth.admin.email,
    created_at: auth.admin.created_at,
  });
}

async function handleAdminUsers(request, env) {
  const auth = await requireOwner(request, env);
  if (!auth.ok) return auth.response;
  const resp = await supabaseAdminFetch(
    env,
    "/rest/v1/admin_users?select=user_id,role,display_name,email,created_at&order=created_at.asc",
  );
  if (!resp.ok) return supabaseErrorResponse(resp);
  return json(await resp.json());
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

  const displayName = String(body?.display_name || "").trim();
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");

  if (displayName.length < 2 || displayName.length > 80)
    return json({ error: "Name must be between 2 and 80 characters." }, 400);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return json({ error: "Enter a valid email address." }, 400);
  if (password.length < 12 || password.length > 128)
    return json({ error: "Initial password must be between 12 and 128 characters." }, 400);

  // Check existing admin
  const existing = await supabaseAdminFetch(
    env,
    `/rest/v1/admin_users?select=user_id&email=eq.${encodeURIComponent(email)}&limit=1`,
  );
  if (!existing.ok) return supabaseErrorResponse(existing);
  if ((await existing.json()).length)
    return json({ error: "That email is already a Cricketive administrator." }, 409);

  // Create Auth user
  const authResp = await fetch(`${SUPABASE_PROJECT_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    }),
  });
  const authData = await authResp.json().catch(() => ({}));
  if (!authResp.ok) {
    return json(
      { error: authData?.msg || authData?.message || "Unable to create the account." },
      authResp.status === 422 ? 409 : 502,
    );
  }
  const userId = authData?.id;
  if (!userId) return json({ error: "Auth did not return user ID." }, 502);

  // Insert into admin_users
  const adminResp = await supabaseAdminFetch(env, "/rest/v1/admin_users", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      user_id: userId,
      role: "admin",
      display_name: displayName,
      email,
    }),
  });
  if (!adminResp.ok) {
    // Rollback Auth
    await fetch(`${SUPABASE_PROJECT_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }).catch(() => {});
    return supabaseErrorResponse(adminResp);
  }
  const created = (await adminResp.json())[0];

  await writeAdminAudit(env, {
    actor_user_id: auth.user.id,
    actor_type: "admin",
    action: "INSERT",
    table_name: "admin_users",
    record_id: userId,
    old_data: null,
    new_data: { user_id: userId, role: "admin", display_name: displayName, email },
  });

  return json(
    {
      user: {
        user_id: created.user_id,
        role: created.role,
        display_name: created.display_name,
        email: created.email,
        created_at: created.created_at,
      },
    },
    201,
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
  const userId = String(body?.user_id || "").trim();
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(userId)) return json({ error: "Invalid administrator ID." }, 400);
  if (userId === auth.user.id)
    return json({ error: "The owner account cannot be removed." }, 403);

  const lookup = await supabaseAdminFetch(
    env,
    `/rest/v1/admin_users?select=user_id,role,display_name,email,created_at&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
  );
  if (!lookup.ok) return supabaseErrorResponse(lookup);
  const rows = await lookup.json();
  if (!rows.length) return json({ error: "Administrator not found." }, 404);
  const admin = rows[0];
  if (admin.role === "owner")
    return json({ error: "The owner account cannot be removed." }, 403);

  const dbDelete = await supabaseAdminFetch(
    env,
    `/rest/v1/admin_users?user_id=eq.${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  if (!dbDelete.ok) return supabaseErrorResponse(dbDelete);

  await writeAdminAudit(env, {
    actor_user_id: auth.user.id,
    actor_type: "admin",
    action: "DELETE",
    table_name: "admin_users",
    record_id: userId,
    old_data: admin,
    new_data: null,
  });

  const authDelete = await fetch(
    `${SUPABASE_PROJECT_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    {
      method: "DELETE",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
  );
  if (!authDelete.ok && authDelete.status !== 404) {
    return json(
      { error: "Admin access revoked, but Auth account cleanup failed." },
      502,
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
    new_data: { event: "password_change" },
  });
  return json({ ok: true });
}

// ------------------- Match / Live Score Endpoints -----------
async function fetchJsonWithRetry(url, options = {}, attempts = 3, delayMs = 700) {
  let lastError = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const resp = await fetch(url, options);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const payload = await resp.json();
      if (payload.error) throw new Error(payload.error);
      return payload;
    } catch (err) {
      lastError = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
  throw lastError || new Error("Request failed.");
}

async function handleCricketMatches(request, env) {
  const SPORTSCORE_MATCHES_URL =
    "https://sportscore.com/api/widget/matches/?sport=cricket&limit=50&src=cricketive";

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

    if (!payload || typeof payload !== "object") {
      return json(
        {
          error: "Invalid response from SportScore."
        },
        502
      );
    }

    return json(payload);

  } catch (err) {

    console.error(
      "Cricketive SportScore match feed error:",
      err
    );

    return json(
      {
        error:
          err?.message ||
          "Unable to fetch cricket matches from SportScore.",
        source: "sportscore-api"
      },
      502
    );
  }
}
async function handleLiveScores(request, env) {
  const url = new URL(request.url);
  const matchUrl = url.searchParams.get("url");
  if (!matchUrl) {
    return json({ error: "Missing 'url' parameter." }, 400);
  }
  // Fetch from SportScore live score endpoint (you need to implement the actual call)
  // This is a placeholder; replace with your actual logic.
  try {
    // Example: forward to SportScore API
    const resp = await fetch(
      `https://sportscore.com/api/live?url=${encodeURIComponent(matchUrl)}`,
      { cache: "no-store" },
    );
    const data = await resp.json();
    return json({ score: data });
  } catch (err) {
    return json({ error: err.message || "Live score unavailable." }, 500);
  }
}

// ------------------- Audit Log Endpoint (Owner only) -------
async function handleAdminAudit(request, env) {
  const auth = await requireOwner(request, env);
  if (!auth.ok) return auth.response;

  const resp = await supabaseAdminFetch(
    env,
    "/rest/v1/admin_audit_log?select=*&order=created_at.desc&limit=500",
  );
  if (!resp.ok) return supabaseErrorResponse(resp);
  return json(await resp.json());
}

// ============================================================
// MAIN FETCH
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // ---- Admin routes ----
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
    if (url.pathname === "/api/admin/password-audit" && request.method === "POST") {
      return handlePasswordAudit(request, env);
    }
    if (url.pathname === "/api/admin/audit" && request.method === "GET") {
      return handleAdminAudit(request, env);
    }

    // ---- Match / Live routes ----
    if (url.pathname === "/api/cricket-matches" && request.method === "GET") {
      return handleCricketMatches(request, env);
    }
    if (url.pathname === "/api/live-scores" && request.method === "GET") {
      return handleLiveScores(request, env);
    }

    // ---- Static assets ----
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // ---- Fallback ----
    return new Response("Cricketive Worker is running.", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
