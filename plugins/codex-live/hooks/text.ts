// Segment first, then measure/cut. ASCII avoids Segmenter's cost on long logs.
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;
export function clusters(text: string): string[] {
  return !segmenter || /^[\x00-\x7f]*$/.test(text) ? [...text] : Array.from(segmenter.segment(text), part => part.segment);
}
function pointWidth(char: string): number {
  const cp = char.codePointAt(0) ?? 0;
  if (/\p{Mark}/u.test(char) || cp === 0x200d) return 0;
  if (/\p{Emoji_Presentation}/u.test(char)) return 2;
  return cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x1f000) ? 2 : 1;
}
export function cells(cluster: string): number {
  if (/[\u200d\ufe0f\u20e3]/u.test(cluster)) return 2;
  let n = 0;
  for (const char of cluster) n = Math.max(n, pointWidth(char));
  return n;
}
export const width = (text: string): number => clusters(text).reduce((n, cluster) => n + cells(cluster), 0);
export function limitChars(text: string, characters: number): string {
  if (text.length <= characters) return text;
  let used = 0;
  let end = '';
  for (const cluster of clusters(text)) {
    if (used + cluster.length > characters) break;
    end += cluster;
    used += cluster.length;
  }
  return end;
}
export function fit(text: string, columns: number): string {
  if (columns <= 0) return '';
  if (width(text) <= columns) return text;
  let result = '';
  let used = 0;
  for (const cluster of clusters(text)) {
    if (used + cells(cluster) > columns - 1) break;
    result += cluster;
    used += cells(cluster);
  }
  return `${result}…`;
}
