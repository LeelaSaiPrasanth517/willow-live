export function createCircuitBreaker() {
  return { state: 'closed', failures: 0 };
}
