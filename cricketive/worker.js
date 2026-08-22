import { handleLiveRequest } from './src/api/live.js';
import { handleMatchRequest } from './src/api/match.js';
import { handleAdminRequest } from './src/api/admin.js';
export { MatchDurableObject } from './src/match/durable-object.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/live') return handleLiveRequest(request, env, ctx);
    if (url.pathname.startsWith('/api/matches/')) return handleMatchRequest(request, env, ctx);
    if (url.pathname.startsWith('/api/admin')) return handleAdminRequest(request, env, ctx);

    return new Response('Cricketive is online', { status: 200 });
  },
};
