export function confidenceForSources(total, agreeing) {
  return total ? agreeing / total : 0;
}
