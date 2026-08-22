export function hasQuorum(values, minimum = 2) {
  return values.filter(Boolean).length >= minimum;
}
