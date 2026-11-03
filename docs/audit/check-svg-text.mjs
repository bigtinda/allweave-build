import { readFileSync } from "node:fs";

// Rough width estimate: CJK/full-width = 1.0em, others = 0.55em, minus kerning slack.
function estWidth(str, size) {
  let w = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    const cjk =
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0x3000 && code <= 0x303f);
    w += (cjk ? 1.0 : 0.55) * size;
  }
  return w;
}

for (const file of process.argv.slice(2)) {
  const text = readFileSync(file, "utf8");
  const vb = /viewBox="([^"]+)"/.exec(text);
  const vbW = +vb[1].split(/\s+/)[2];
  const vbH = +vb[1].split(/\s+/)[3];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  const issues = [];
  let m;
  while ((m = re.exec(text))) {
    const attrs = m[1];
    const body = m[2].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    const x = +( /\bx="([\d.]+)"/.exec(attrs)?.[1] ?? 0);
    const y = +( /\by="([\d.]+)"/.exec(attrs)?.[1] ?? 0);
    const cls = /\bclass="([^"]+)"/.exec(attrs)?.[1];
    const fsAttr = /\bfont-size="([\d.]+)"/.exec(attrs)?.[1];
    const style = /\bstyle="([^"]*)"/.exec(attrs)?.[1] ?? "";
    let size = fsAttr ? +fsAttr : null;
    if (!size) {
      const map = { title: 22, sub: 11.5, h: 13, t: 11, m: 10.5, k: 11.5, tag: 11, cm: 10 };
      size = cls && map[cls] ? map[cls] : 11;
    }
    const w = estWidth(body, size);
    if (x + w > vbW - 6) issues.push(`overflow-right y=${y} x=${x} w=${Math.round(w)} "${body.slice(0, 40)}"`);
    if (y > vbH - 2) issues.push(`below-canvas y=${y} "${body.slice(0, 30)}"`);
    if (/style="[^"]*display:\s*none/.test(style)) continue;
  }
  console.log(`\n== ${file} text-elements=${(text.match(/<text\b/g) || []).length}`);
  console.log(issues.length ? `WARN:\n - ${issues.join("\n - ")}` : "no text overflow detected");
}
