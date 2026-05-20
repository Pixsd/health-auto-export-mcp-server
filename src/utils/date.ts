// Parses a Health Auto Export date string ("2026-05-09 08:01:00 +0200") into a Date.
export function parseHAEDate(s: string): Date {
    return new Date(s.replace(' ', 'T').replace(/ (?=[+-])/, ''));
}
