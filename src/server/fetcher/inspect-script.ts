/**
 * Runs inside the page (serialized by Playwright). Collects visible elements with
 * their position and two selectors: one that matches only this element, and a
 * general one that matches it and its look-alikes (other cards in the same list).
 * Must stay self-contained: no imports, no closures over outer variables.
 */
export function collectBoxes(limits: { maxBoxes: number; maxHeight: number }) {
  const esc = (s: string) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, "\\$1"));
  const stable = (el: Element) =>
    Array.from(el.classList)
      .filter((c) => c.length < 40 && !/\d{3,}|^(active|selected|hover|odd|even|first|last|is-|has-|js-)/.test(c))
      .slice(0, 2);
  const seg = (el: Element) => el.tagName.toLowerCase() + stable(el).map((c) => "." + esc(c)).join("");
  const count = (sel: string) => { try { return document.querySelectorAll(sel).length; } catch { return 0; } };

  function unique(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body && parts.length < 8) {
      if (cur.id && !/\d{4,}/.test(cur.id) && count("#" + esc(cur.id)) === 1) { parts.unshift("#" + esc(cur.id)); break; }
      let s = seg(cur);
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
        if (same.length > 1) s += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(s);
      const sel = parts.join(" > ");
      if (count(sel) === 1) return sel;
      cur = parent;
    }
    return parts.join(" > ");
  }

  function general(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body && parts.length < 4) {
      if (cur.id && !/\d{4,}/.test(cur.id) && count("#" + esc(cur.id)) === 1) { parts.unshift("#" + esc(cur.id)); break; }
      parts.unshift(seg(cur));
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  const out: { x: number; y: number; w: number; h: number; tag: string; text: string; selector: string; general: string; similar: number; href: string | null; src: string | null }[] = [];
  const all = Array.from(document.body.querySelectorAll("*"));
  for (const el of all) {
    if (out.length >= limits.maxBoxes) break;
    if (/^(script|style|noscript|template|svg|path|br|head|meta|link)$/i.test(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    const y = r.top + window.scrollY;
    if (r.width < 6 || r.height < 6 || y > limits.maxHeight) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
    const text = (el as HTMLElement).innerText?.replace(/\s+/g, " ").trim().slice(0, 140) ?? "";
    const isMedia = el.tagName === "IMG" || el.tagName === "A";
    if (!text && !isMedia) continue;
    // Skip huge wrappers; they are rarely what someone wants to pick.
    if (r.width * r.height > window.innerWidth * 1400 && el.children.length > 3) continue;
    const g = general(el);
    out.push({
      x: Math.round(r.left + window.scrollX), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height),
      tag: el.tagName.toLowerCase(), text, selector: unique(el), general: g, similar: count(g),
      href: el.getAttribute("href") ? (el as HTMLAnchorElement).href ?? null : el.closest("a")?.href ?? null,
      src: el.tagName === "IMG" ? (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src : null,
    });
  }
  return { boxes: out, width: document.documentElement.scrollWidth, height: Math.min(document.documentElement.scrollHeight, limits.maxHeight) };
}

export type InspectResult = ReturnType<typeof collectBoxes>;
