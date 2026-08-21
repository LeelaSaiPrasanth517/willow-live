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

/* ---------------------------------------------------------
   SUPABASE ADMIN REQUEST
--------------------------------------------------------- */

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

/* ---------------------------------------------------------
   SUPABASE ERROR
--------------------------------------------------------- */

async function supabaseErrorResponse(response) {
  const data =
    await response
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

/* ---------------------------------------------------------
   AUTHENTICATE SUPABASE USER
--------------------------------------------------------- */

async function getAuthenticatedUser(request, env) {

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {

    return {
      ok: false,

      response: json(
        {
          error:
            "Server authentication is not configured."
        },

        500
      )
    };
  }

  const token =
    getBearerToken(request);

  if (!token) {

    return {
      ok: false,

      response: json(
        {
          error:
            "Authentication required."
        },

        401
      )
    };
  }

  const response =
    await fetch(
      `${SUPABASE_PROJECT_URL}/auth/v1/user`,

      {
        headers: {

          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          Authorization:
            `Bearer ${token}`
        }
      }
    );

  if (!response.ok) {

    return {
      ok: false,

      response: json(
        {
          error:
            "Invalid or expired session."
        },

        401
      )
    };
  }

  const user =
    await response.json();

  if (!user?.id) {

    return {
      ok: false,

      response: json(
        {
          error:
            "Invalid authenticated user."
        },

        401
      )
    };
  }

  return {
    ok: true,
    user
  };
}

/* ---------------------------------------------------------
   REQUIRE ADMIN
--------------------------------------------------------- */

async function requireAdmin(request, env) {

  const auth =
    await getAuthenticatedUser(
      request,
      env
    );

  if (!auth.ok) {
    return auth;
  }

  const response =
    await supabaseAdminFetch(
      env,

      `/rest/v1/admin_users` +
      `?select=user_id,role,display_name,email,created_at` +
      `&user_id=eq.${encodeURIComponent(auth.user.id)}` +
      `&limit=1`
    );

  if (!response.ok) {

    return {
      ok: false,

      response:
        await supabaseErrorResponse(
          response
        )
    };
  }

  const admins =
    await response.json();

  if (!admins.length) {

    return {
      ok: false,

      response: json(
        {
          error:
            "Administrator access required."
        },

        403
      )
    };
  }

  return {
    ok: true,

    user: auth.user,

    admin: admins[0]
  };
}

/* ---------------------------------------------------------
   REQUIRE OWNER
--------------------------------------------------------- */

async function requireOwner(request, env) {

  const auth =
    await requireAdmin(
      request,
      env
    );

  if (!auth.ok) {
    return auth;
  }

  if (auth.admin.role !== "owner") {

    return {
      ok: false,

      response: json(
        {
          error:
            "Owner access required."
        },

        403
      )
    };
  }

  return auth;
}

/* ---------------------------------------------------------
   GET CURRENT ADMIN
   GET /api/admin/me
--------------------------------------------------------- */

async function handleAdminMe(request, env) {

  const auth =
    await requireAdmin(
      request,
      env
    );

  if (!auth.ok) {
    return auth.response;
  }

  return json({
    user_id:
      auth.admin.user_id,

    role:
      auth.admin.role,

    display_name:
      auth.admin.display_name,

    email:
      auth.admin.email,

    created_at:
      auth.admin.created_at
  });
}

/* ---------------------------------------------------------
   LIST ADMINS
   GET /api/admin/users
   OWNER ONLY
--------------------------------------------------------- */

async function handleAdminUsers(request, env) {

  const auth =
    await requireOwner(
      request,
      env
    );

  if (!auth.ok) {
    return auth.response;
  }

  const response =
    await supabaseAdminFetch(
      env,

      "/rest/v1/admin_users" +
      "?select=user_id,role,display_name,email,created_at" +
      "&order=created_at.asc"
    );

  if (!response.ok) {

    return supabaseErrorResponse(
      response
    );
  }

  return json(
    await response.json()
  );
}

/* ---------------------------------------------------------
   CREATE ADMIN
   POST /api/admin/users
   OWNER ONLY
--------------------------------------------------------- */

async function handleCreateAdmin(
  request,
  env
) {

  const auth =
    await requireOwner(
      request,
      env
    );

  if (!auth.ok) {
    return auth.response;
  }

  let body;

  try {

    body =
      await request.json();

  } catch {

    return json(
      {
        error:
          "Invalid request body."
      },

      400
    );
  }

  const displayName =
    String(
      body?.display_name || ""
    ).trim();

  const email =
    String(
      body?.email || ""
    )
      .trim()
      .toLowerCase();

  const password =
    String(
      body?.password || ""
    );

  /* Validate name */

  if (
    displayName.length < 2 ||
    displayName.length > 80
  ) {

    return json(
      {
        error:
          "Name must be between 2 and 80 characters."
      },

      400
    );
  }

  /* Validate email */

  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      email
    )
  ) {

    return json(
      {
        error:
          "Enter a valid email address."
      },

      400
    );
  }

  /* Validate password */

  if (
    password.length < 12 ||
    password.length > 128
  ) {

    return json(
      {
        error:
          "Initial password must be between 12 and 128 characters."
      },

      400
    );
  }

  /* Check duplicate admin */

  const existing =
    await supabaseAdminFetch(
      env,

      `/rest/v1/admin_users` +
      `?select=user_id` +
      `&email=eq.${encodeURIComponent(email)}` +
      `&limit=1`
    );

  if (!existing.ok) {

    return supabaseErrorResponse(
      existing
    );
  }

  const existingRows =
    await existing.json();

  if (existingRows.length) {

    return json(
      {
        error:
          "That email is already a Cricketive administrator."
      },

      409
    );
  }

  /* Create Supabase Auth account */

  const authResponse =
    await fetch(
      `${SUPABASE_PROJECT_URL}/auth/v1/admin/users`,

      {
        method: "POST",

        headers: {

          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          Authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({

            email,

            password,

            email_confirm:
              true,

            user_metadata: {

              display_name:
                displayName
            }
          })
      }
    );

  const authData =
    await authResponse
      .json()
      .catch(() => ({}));

  if (!authResponse.ok) {

    return json(
      {
        error:
          authData?.msg ||
          authData?.message ||
          "Unable to create the account."
      },

      authResponse.status === 422
        ? 409
        : 502
    );
  }

  const userId =
    authData?.id;

  if (!userId) {

    return json(
      {
        error:
          "Supabase Auth did not return a user ID."
      },

      502
    );
  }

  /* Create admin_users record */

  const adminResponse =
    await supabaseAdminFetch(
      env,

      "/rest/v1/admin_users",

      {
        method:
          "POST",

        headers: {

          Prefer:
            "return=representation"
        },

        body:
          JSON.stringify({

            user_id:
              userId,

            role:
              "admin",

            display_name:
              displayName,

            email
          })
      }
    );

  if (!adminResponse.ok) {

    /* Roll back Auth account */

    await fetch(
      `${SUPABASE_PROJECT_URL}/auth/v1/admin/users/${encodeURIComponent(
        userId
      )}`,

      {
        method:
          "DELETE",

        headers: {

          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          Authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    ).catch(() => {});

    return supabaseErrorResponse(
      adminResponse
    );
  }

  const created =
    (await adminResponse.json())[0];

  /* Audit */

  await writeAdminAudit(
    env,

    {
      actor_user_id:
        auth.user.id,

      actor_type:
        "admin",

      action:
        "INSERT",

      table_name:
        "admin_users",

      record_id:
        userId,

      old_data:
        null,

      new_data: {

        user_id:
          userId,

        role:
          "admin",

        display_name:
          displayName,

        email
      }
    }
  );

  return json(
    {
      user: {

        user_id:
          created.user_id,

        role:
          created.role,

        display_name:
          created.display_name,

        email:
          created.email,

        created_at:
          created.created_at
      }
    },

    201
  );
}

/* ---------------------------------------------------------
   DELETE ADMIN
   DELETE /api/admin/users
   OWNER ONLY
--------------------------------------------------------- */

async function handleDeleteAdmin(
  request,
  env
) {

  const auth =
    await requireOwner(
      request,
      env
    );

  if (!auth.ok) {
    return auth.response;
  }

  let body;

  try {

    body =
      await request.json();

  } catch {

    return json(
      {
        error:
          "Invalid request body."
      },

      400
    );
  }

  const userId =
    String(
      body?.user_id || ""
    ).trim();

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (
    !uuidPattern.test(
      userId
    )
  ) {

    return json(
      {
        error:
          "Invalid administrator ID."
      },

      400
    );
  }

  /* Owner cannot delete themselves */

  if (
    userId ===
    auth.user.id
  ) {

    return json(
      {
        error:
          "The owner account cannot be removed."
      },

      403
    );
  }

  /* Get admin */

  const lookup =
    await supabaseAdminFetch(
      env,

      `/rest/v1/admin_users` +
      `?select=user_id,role,display_name,email,created_at` +
      `&user_id=eq.${encodeURIComponent(userId)}` +
      `&limit=1`
    );

  if (!lookup.ok) {

    return supabaseErrorResponse(
      lookup
    );
  }

  const rows =
    await lookup.json();

  if (!rows.length) {

    return json(
      {
        error:
          "Administrator not found."
      },

      404
    );
  }

  const admin =
    rows[0];

  /* Never delete owner */

  if (
    admin.role ===
    "owner"
  ) {

    return json(
      {
        error:
          "The owner account cannot be removed."
      },

      403
    );
  }

  /* Remove database admin record */

  const dbDelete =
    await supabaseAdminFetch(
      env,

      `/rest/v1/admin_users?user_id=eq.${encodeURIComponent(
        userId
      )}`,

      {
        method:
          "DELETE"
      }
    );

  if (!dbDelete.ok) {

    return supabaseErrorResponse(
      dbDelete
    );
  }

  /* Audit before Auth deletion */

  await writeAdminAudit(
    env,

    {
      actor_user_id:
        auth.user.id,

      actor_type:
        "admin",

      action:
        "DELETE",

      table_name:
        "admin_users",

      record_id:
        userId,

      old_data:
        admin,

      new_data:
        null
    }
  );

  /* Delete Auth account */

  const authDelete =
    await fetch(
      `${SUPABASE_PROJECT_URL}/auth/v1/admin/users/${encodeURIComponent(
        userId
      )}`,

      {
        method:
          "DELETE",

        headers: {

          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          Authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );

  if (
    !authDelete.ok &&
    authDelete.status !== 404
  ) {

    return json(
      {
        error:
          "Administrator access was revoked, but the Auth account could not be cleaned up."
      },

      502
    );
  }

  return json({
    ok:
      true
  });
}

/* ---------------------------------------------------------
   PASSWORD AUDIT
   POST /api/admin/password-audit
--------------------------------------------------------- */

async function handlePasswordAudit(
  request,
  env
) {

  const auth =
    await requireAdmin(
      request,
      env
    );

  if (!auth.ok) {
    return auth.response;
  }

  await writeAdminAudit(
    env,

    {
      actor_user_id:
        auth.user.id,

      actor_type:
        "admin",

      action:
        "UPDATE",

      table_name:
        "auth.users",

      record_id:
        auth.user.id,

      old_data: {
        event:
          "password_change"
      },

      new_data: {
        event:
          "password_change"
      }
    }
  );

  return json({
    ok:
      true
  });
}

/* ---------------------------------------------------------
   AUDIT WRITER
--------------------------------------------------------- */

async function writeAdminAudit(
  env,
  entry
) {

  return supabaseAdminFetch(
    env,

    "/rest/v1/admin_audit_log",

    {
      method:
        "POST",

      headers: {

        Prefer:
          "return=minimal"
      },

      body:
        JSON.stringify(entry)
    }
  );
}
