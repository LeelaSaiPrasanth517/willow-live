export function trace(name, attributes = {}) {
  return { name, attributes, startedAt: new Date().toISOString() };
}
