export function applyCorrection(match, correction) {
  return { ...match, ...correction, corrected: true };
}
