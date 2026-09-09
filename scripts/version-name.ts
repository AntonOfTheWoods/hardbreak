/** EGO display labels allow 1–16 letters, digits, spaces or dots, with an alphanumeric. */
export function versionName(description: string): string | undefined {
  const label = description
    .replace(/^v/, '')
    .replace(/[^A-Za-z0-9 .]/g, '.')
    .slice(0, 16);
  return /^(?![. ]+$)[A-Za-z0-9 .]{1,16}$/.test(label) ? label : undefined;
}
