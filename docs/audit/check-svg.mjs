import { readFileSync } from "node:fs";

function check(file) {
  const text = readFileSync(file, "utf8");
  const problems = [];
  const replacementChars = (text.match(/\uFFFD/g) || []).length;
  if (replacementChars) problems.push(`replacement chars: ${replacementChars}`);
  if (text.includes("\u0000")) problems.push("NUL byte");

  const tagRe = /<\/?([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const stack = [];
  let m;
  let count = 0;
  const stripComments = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "").replace(/<!DOCTYPE[^>]*>/g, "");
  while ((m = tagRe.exec(stripComments))) {
    count += 1;
    const [raw, name, , selfClose] = m;
    const isClose = raw.startsWith("</");
    if (isClose) {
      if (!stack.length) problems.push(`extra close </${name}> at ${m.index}`);
      else if (stack[stack.length - 1] !== name) problems.push(`mismatch </${name}> expected </${stack[stack.length - 1]}> at ${m.index}`);
      else stack.pop();
    } else if (!selfClose) {
      if (name === "svg" || name === "g" || name === "defs" || name === "symbol" || name === "marker" || name === "clipPath" || name === "linearGradient" || name === "style" || name === "text" || name === "rect" || name === "path" || name === "circle" || name === "line" || name === "polygon" || name === "polyline" || name === "ellipse" || name === "title" || name === "desc" || name === "tspan") stack.push(name);
      else problems.push(`unknown tag <${name}>`);
    }
  }
  if (stack.length) problems.push(`unclosed: ${stack.join(",")}`);

  let depth = 0;
  const textOnly = stripComments.replace(/<[^>]*>/g, "");
  for (const ch of textOnly) {
    if (ch === "&") { if (text.slice(0, 0)) {} }
  }
  const amp = textOnly.match(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g);
  if (amp) problems.push(`unescaped & x${amp.length}`);
  const badLt = /<(?!\/?[A-Za-z])/g.test(textOnly);

  // bounds from attributes
  let maxX = 0, maxY = 0;
  const rectRe = /<rect[^>]*\bx="([\d.]+)"[^>]*\by="([\d.]+)"[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/g;
  let r;
  while ((r = rectRe.exec(text))) {
    maxX = Math.max(maxX, +r[1] + +r[3]);
    maxY = Math.max(maxY, +r[2] + +r[4]);
  }
  const vb = /viewBox="([^"]+)"/.exec(text);
  const vbW = vb ? +vb[1].split(/\s+/)[2] : 0;
  const vbH = vb ? +vb[1].split(/\s+/)[3] : 0;
  if (maxX > vbW) problems.push(`rect exceeds width: ${maxX} > ${vbW}`);
  if (maxY > vbH) problems.push(`rect exceeds height: ${maxY} > ${vbH}`);

  console.log(`\n== ${file}`);
  console.log(`bytes=${Buffer.byteLength(text)} tags=${count} viewBox=${vb ? vb[1] : "MISSING"} maxRect=${maxX}x${maxY}`);
  console.log(problems.length ? `PROBLEMS:\n - ${problems.join("\n - ")}` : "OK");
  return problems.length;
}

let bad = 0;
for (const f of process.argv.slice(2)) bad += check(f);
process.exit(bad ? 1 : 0);
