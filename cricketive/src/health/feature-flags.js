export function isFeatureEnabled(env, name) {
  return env[name] === 'true';
}
