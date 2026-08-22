export function isInningsComplete(innings) {
  return Boolean(innings?.allOut || innings?.oversCompleted);
}
