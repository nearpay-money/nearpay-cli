/** Version of this CLI (kept equal to package.json by `test/unit/package.test.ts`). */
export const CLI_VERSION = "0.2.0";

/** `User-Agent` of every API call. */
export function userAgent(): string {
  return `nearpay-cli/${CLI_VERSION} node/${process.version} (${process.platform}; ${process.arch})`;
}
