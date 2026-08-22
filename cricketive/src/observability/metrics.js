export function metric(name, value, tags = {}) {
  return { name, value, tags };
}
