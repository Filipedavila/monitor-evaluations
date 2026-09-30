export function formatDate(isoDate: string): string {
  return isoDate.replace(/T/, ' ').replace(/\..+/, '');
}
