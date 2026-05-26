export function nowIso(): string {
  return new Date().toISOString();
}

export function addHoursIso(hours: number, from = new Date()): string {
  return new Date(from.getTime() + hours * 60 * 60 * 1000).toISOString();
}

export function minutesAgoIso(minutes: number, from = new Date()): string {
  return new Date(from.getTime() - minutes * 60 * 1000).toISOString();
}
