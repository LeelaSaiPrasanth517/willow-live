import { MatchStateDurableObject } from "./src/match/durable-object.js";
import { getCanonicalLive, ingestSportScore } from "./src/api/live.js";
import { getCanonicalMatch } from "./src/api/match.js";
import { handleAdmin } from "./src/api/admin.js";
import { trace, safeError } from "./src/observability/tracing.js";

export { MatchStateDurableObject };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      const admin = await handleAdmin(request, env, url.pathname);
      if (admin) return admin;
      if (url.pathname === "/api/cricket/live" && request.method === "GET") return canonicalLiveResponse(request, env);
      const matchWs = url.pathname.match(/^\/api\/cricket\/live\/([^/]+)\/ws$/);
      if (matchWs && request.method === "GET") return proxyMatchObject(env, decodeURIComponent(matchWs[1]), request);
      const matchApi = url.pathname.match(/^\/api\/cricket\/match\/([^/]+)$/);
      if (matchApi && request.method === "GET") {
        const data = await getCanonicalMatch(env, decodeURIComponent(matchApi[1]));
        return data ? json({ success: true, match: data }) : json({ success: false, error: "Match not found." }, 404);
      }
      if (url.pathname === "/api/cricket-matches" && request.method === "GET") return json(compatMatches(await getCanonicalLive(env, { force: true })));
      if (url.pathname === "/api/live-scores" && request.method === "GET") return compatibilityLiveScore(url, env);
      if (url.pathname === "/api/health" && request.method === "GET") return json({ ok: true, service: "cricketive-worker", time: new Date().toISOString() });
      return env.ASSETS.fetch(request);
    } catch (error) {
      trace("request_error", { path: url.pathname, message: safeError(error) });
      return json({ success: false, error: safeError(error), code: "INTERNAL_ERROR" }, 500);
    }
  },
  async scheduled(controller, env) {
    try { await ingestSportScore(env, { force: true }); trace("scheduled_ingestion_complete", { cron: controller.cron }); }
    catch (error) { trace("scheduled_ingestion_failed", { message: safeError(error) }); }
  }
};

async function canonicalLiveResponse(request, env) {
  const data = await getCanonicalLive(env, { force: true });
  const versions = data.matches.map(m => Number(m.state_version || 0));
  const maxVersion = versions.length ? Math.max(...versions) : 0;
  const etag = `"cricketive-${maxVersion}-${data.matches.length}"`;
  if (request.headers.get("If-None-Match") === etag && !data.stale) return new Response(null, { status: 304, headers: { ETag: etag, "cache-control": "no-cache" } });
  return json(data, 200, { ETag: etag, "cache-control": data.stale ? "no-store" : "private, max-age=2, stale-while-revalidate=5" });
}
async function proxyMatchObject(env, canonicalId, request) {
  const id = env.MATCH_STATE.idFromName(canonicalId);
  const stub = env.MATCH_STATE.get(id);
  return stub.fetch(new Request(`https://match/${encodeURIComponent(canonicalId)}/ws`, request));
}
async function compatibilityLiveScore(url, env) {
  const sourceUrl = url.searchParams.get("url");
  const data = await getCanonicalLive(env, { force: true });
  if (!sourceUrl) return json({ score: null, scores: {}, updated: data.generated_at });
  const normalized = normalizeSportScoreUrl(sourceUrl);
  const match = data.matches.find(m => normalizeSportScoreUrl(m.sportscore_url) === normalized);
  const score = match ? { home: match.team1, away: match.team2, home_score: match.score?.home?.text ?? null, away_score: match.score?.away?.text ?? null, status: match.status, status_text: match.status_reason, batting_team: match.batting_team, overs: match.score?.overs, updated_at: match.updated_at, state_version: match.state_version } : null;
  return json({ score, scores: score ? { [normalized]: score } : {}, updated: data.generated_at });
}
function compatMatches(data) {
  return { sport: "cricket", count: data.matches.length, live_count: data.matches.filter(m => m.status === "LIVE").length, upcoming_count: data.matches.filter(m => m.status === "UPCOMING").length, finished_count: data.matches.filter(m => m.status === "FINISHED").length, unknown_count: data.matches.filter(m => m.status === "UNKNOWN").length, updated: data.generated_at, stale: Boolean(data.stale), data_status: data.data_status, source: "cricketive-canonical", matches: data.matches.map(m => ({ home: m.team1, away: m.team2, home_logo: "", away_logo: "", home_score: m.score?.home?.text ?? null, away_score: m.score?.away?.text ?? null, status: titleStatus(m.status), status_text: m.status_reason, batting_team: m.batting_team, overs: m.score?.overs ?? null, time: m.start_time, competition: m.competition, url: m.sportscore_url ?? "", sportscore_url: m.sportscore_url ?? "", canonical_match_id: m.canonical_match_id, state_version: m.state_version, provisional: m.provisional, confidence: m.confidence, anomaly_score: m.anomaly_score, stream_status: m.stream_status, stream_count: m.stream_count, stale: m.stale })) };
}
function titleStatus(s) { return ({ LIVE:"Live", UPCOMING:"Upcoming", FINISHED:"Finished", SUSPENDED:"Suspended", POSTPONED:"Postponed", CANCELLED:"Cancelled", ABANDONED:"Abandoned", UNKNOWN:"Unknown" })[s] ?? "Unknown"; }
function normalizeSportScoreUrl(value) { if (!value) return ""; const s=String(value).trim(); return (s.startsWith("http") ? s : `https://sportscore.com${s.startsWith("/") ? s : `/${s}`}`).replace(/\/+$/, ""); }
function json(data, status=200, extra={}) { return new Response(JSON.stringify(data), { status, headers: { "content-type":"application/json; charset=utf-8", "access-control-allow-origin":"*", "access-control-allow-headers":"Authorization, Content-Type, If-None-Match", ...extra } }); }
