/**
 * Opens a URL in the user's browser without a shell (the URL is one argv entry, never interpolated
 * into a command line). Only `https:` URLs (and `http:` on loopback, for local stacks) are opened.
 */
import { spawn } from "node:child_process";
import { isLoopbackHost } from "./api.js";

export type OpenUrl = (url: string) => Promise<boolean>;

/** Whether `url` is safe to hand to the OS opener. */
export function isOpenableUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" || (u.protocol === "http:" && isLoopbackHost(u.hostname));
}

/** The opener command for a platform. */
export function openerFor(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  // rundll32 takes the URL as one argument; `cmd /c start` would re-parse `&` in query strings.
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

export function systemOpener(platform: NodeJS.Platform = process.platform): OpenUrl {
  return (url) =>
    new Promise((resolve) => {
      if (!isOpenableUrl(url)) {
        resolve(false);
        return;
      }
      const [cmd, args] = openerFor(platform, url);
      try {
        const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: false });
        child.once("error", () => resolve(false));
        child.once("spawn", () => {
          child.unref();
          resolve(true);
        });
      } catch {
        resolve(false);
      }
    });
}
