// Finds the true/false values in a server reply and formats responses into JSON
// containing only true/false related fields/words. Shared by bridge.js, background.js, and popup.js.

function isBoolVal(v) {
  return typeof v === "boolean" || (typeof v === "string" && /^(true|false)$/i.test(v.trim()));
}

function toBoolVal(v) {
  return typeof v === "boolean" ? v : v.trim().toLowerCase() === "true";
}

// eslint-disable-next-line no-unused-vars
function extractBools(text, contentType) {
  const MAX = 50;
  const out = [];
  let t = (text || "").trim();
  if (!t) return out;

  // Skip HTML document pages, JS scripts, CSS
  if (t.startsWith("<")) {
    const inner = t.replace(/<!--[\s\S]*?-->|<[^>]*>/g, " ").trim();
    if (inner.length > 200 || /<(html|body|script|head)\b/i.test(t.slice(0, 2000))) return out;
    t = inner;
  } else if (/css/i.test(contentType || "") ||
    /\bfunction\s*[\w$]*\s*\(|=>|\b(var|let|const)\s+[\w$]+\s*=/.test(t.slice(0, 5000))) {
    return out;
  }

  let parsed, isJson = false;
  try {
    parsed = JSON.parse(t);
    isJson = true;
  } catch (_) {}

  if (isJson) {
    (function walk(v, key) {
      if (out.length >= MAX) return;
      if (isBoolVal(v)) {
        out.push({ key: key || "value", value: toBoolVal(v) });
      } else if (Array.isArray(v)) {
        v.forEach((x) => walk(x, key));
      } else if (v && typeof v === "object") {
        for (const k of Object.keys(v)) {
          walk(v[k], k);
        }
      }
    })(parsed, "");
    return out;
  }

  // Plain text / form-encoded / XML / socket frames: "true", "status=false", "ok: True", …
  const re = /(?:["']?([A-Za-z_][\w.-]*)["']?\s*[:=]\s*)?["']?\b(true|false)\b/gi;
  let m;
  while ((m = re.exec(t)) && out.length < MAX) {
    out.push({ key: m[1] || "value", value: m[2].toLowerCase() === "true" });
  }
  return out;
}

// Formats a response into a clean JSON string containing ONLY true/false fields
// eslint-disable-next-line no-unused-vars
function formatBoolJson(text, contentType) {
  let t = (text || "").trim();
  if (!t) return null;

  let parsed, isJson = false;
  try {
    parsed = JSON.parse(t);
    isJson = true;
  } catch (_) {}

  if (isJson) {
    function prune(v) {
      if (isBoolVal(v)) return toBoolVal(v);
      if (Array.isArray(v)) {
        const arr = v.map(prune).filter((x) => x !== undefined);
        return arr.length ? arr : undefined;
      }
      if (v && typeof v === "object") {
        const res = {};
        let count = 0;
        for (const k of Object.keys(v)) {
          const child = prune(v[k]);
          if (child !== undefined) {
            res[k] = child;
            count++;
          }
        }
        return count ? res : undefined;
      }
      return undefined;
    }

    const pruned = prune(parsed);
    if (pruned !== undefined) {
      return prettyJson(pruned);
    }
  }

  const bools = extractBools(text, contentType);
  if (!bools.length) return null;

  if (bools.length === 1 && (!bools[0].key || bools[0].key === "value")) {
    return prettyJson({ value: bools[0].value });
  }

  const obj = {};
  for (const b of bools) {
    const k = b.key || "value";
    if (k in obj) {
      if (!Array.isArray(obj[k])) obj[k] = [obj[k]];
      obj[k].push(b.value);
    } else {
      obj[k] = b.value;
    }
  }
  return prettyJson(obj);
}

// JSON.stringify(v, null, 2), but lists of plain values stay on one line
// eslint-disable-next-line no-unused-vars
function prettyJson(value) {
  const pad = (n) => "  ".repeat(n);
  const flat = (v) => v === null || typeof v !== "object";
  return (function fmt(v, d) {
    if (flat(v)) return JSON.stringify(v);
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      if (v.every(flat)) return "[" + v.map((x) => JSON.stringify(x)).join(", ") + "]";
      return "[\n" + v.map((x) => pad(d + 1) + fmt(x, d + 1)).join(",\n") + "\n" + pad(d) + "]";
    }
    const keys = Object.keys(v);
    if (!keys.length) return "{}";
    return "{\n" + keys.map((k) => pad(d + 1) + JSON.stringify(k) + ": " + fmt(v[k], d + 1)).join(",\n") + "\n" + pad(d) + "}";
  })(value, 0);
}
