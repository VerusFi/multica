/**
 * URL for the landing header's "Selfhost" nav entry, or `null` when the
 * deployment hasn't got one.
 *
 * There is no `/selfhost` route in this app: the selfhost experience is a
 * separate static site (`deploy/selfhost-web/`, deployed to GitHub Pages),
 * so the only correct href is an absolute URL a deployment supplies via
 * `NEXT_PUBLIC_SELFHOST_URL`. Falling back to `/selfhost` — as this used to —
 * shipped a nav link straight to a 404 on every deployment that didn't set
 * the variable, which is all of them. When it's unset the link is omitted
 * entirely instead.
 */
export function selfhostNavUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_SELFHOST_URL;
  return typeof url === "string" && url.trim() !== "" ? url.trim() : null;
}
