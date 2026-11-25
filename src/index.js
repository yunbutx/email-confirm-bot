import PostalMime from "postal-mime";
import puppeteer from "@cloudflare/puppeteer";

const KEYWORDS = ["confirm","confirmation","verify","verification","activate",
  "activation","validate","email-verification","signup","register","token","magic","click","approve"];
const BAD_KEYWORDS = ["unsubscribe","optout","opt-out","delete-account","cancel","logout","signout","report","abuse"];

const SUCCESS_RE = /(verified|confirmed|success(ful)?|activated|thank you|验证成功|确认成功|已完成)/i;
const FAIL_RE = /(expired|invalid|already (been )?(used|verified|confirmed)|not found|链接已失效|已过期)/i;

export default {
  async email(message, env, ctx) {
    const parsed = await PostalMime.parse(message.raw);
    const senderDomain = (message.from.split("@")[1] || "").toLowerCase();

    const allowed = (env.ALLOWED_SENDERS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.some(d => senderDomain === d || senderDomain.endsWith("." + d))) {
      return forwardIfNeeded(message, env);
    }

    const candidates = extractUrls(parsed, senderDomain);
    if (!candidates.length) {
      await log(env, message, { status: "no-link", subject: parsed.subject });
      return forwardIfNeeded(message, env);
    }

    const results = [];
    for (const url of candidates.slice(0, 3)) {
      const key = "seen:" + (await sha256(url));
      if (await env.CONFIRM_LOG.get(key)) { results.push({ url, status: "skipped-duplicate" }); continue; }

      if (env.DRY_RUN === "true") {
        results.push({ url, status: "dry-run" });
        await env.CONFIRM_LOG.put(key, "dry-run", { expirationTtl: 2592000 });
        continue;
      }

      // 1) 轻量 fetch
      let r = await visit(url);

      // 2) 失败 / 疑似 JS 页 → 浏览器回退
      if (!r.ok && env.USE_BROWSER !== "false" && env.BROWSER) {
        r = { ...(await visitWithBrowser(env, url)), via: "browser" };
      }

      results.push({ url, ...r });
      await env.CONFIRM_LOG.put(key, JSON.stringify(r), { expirationTtl: 2592000 });
      if (r.ok) break;
    }

    await log(env, message, {
      status: results.some(r => r.ok) ? "confirmed" : "failed",
      subject: parsed.subject, results,
    });
    return forwardIfNeeded(message, env);
  },
};

/* ---------- 链接提取 ---------- */
function extractUrls(parsed, senderDomain) {
  const html = parsed.html || "", text = parsed.text || "";
  const fromHref = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
  const fromText = [...text.matchAll(/https?:\/\/[^\s<>"')]+/g)].map(m => m[0]);
  const fromBare = [...html.matchAll(/https?:\/\/[^\s<>"')]+/g)].map(m => m[0]);

  return [...new Set([...fromHref, ...fromText, ...fromBare])]
    .map(u => u.replace(/&amp;/g, "&").trim())
    .filter(u => /^https?:\/\//i.test(u))
    .map(url => ({ url, score: scoreUrl(url, senderDomain) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.url);
}

function scoreUrl(url, senderDomain) {
  let score = 0;
  const lower = url.toLowerCase();
  if (BAD_KEYWORDS.some(k => lower.includes(k))) return -100;
  if (KEYWORDS.some(k => lower.includes(k))) score += 10;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === senderDomain || host.endsWith("." + senderDomain)) score += 5;
    if (/click\.|email\.|links\.|track\.|mail\./.test(host)) score += 2;
  } catch { return -100; }
  if (/\.(png|jpe?g|gif|svg|css|js|ico|woff2?)(\?|$)/i.test(lower)) return -100;
  return score;
}

/* ---------- A: 普通 fetch ---------- */
async function visit(url, depth = 0) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    const ct = res.headers.get("content-type") || "";
    let body = "";
    if (ct.includes("text/html") && depth < 2) {
      body = await res.text();
      const meta = body.match(/http-equiv=["']refresh["'][^>]*url=([^"'>\s]+)/i);
      const jsLoc = body.match(/(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
      const next = meta?.[1] || jsLoc?.[1];
      if (next && /^https?:\/\//i.test(next) && next !== url) {
        return { ...(await visit(next, depth + 1)), via: next };
      }
    }

    const jsLikely = /<noscript>|enable javascript|please enable js|__NEXT_DATA__|id=["']root["']/i.test(body.slice(0, 3000));
    const ok = res.ok && !FAIL_RE.test(body.slice(0, 4000)) && (SUCCESS_RE.test(body) || !jsLikely);
    return { ok, status: res.status, finalUrl: res.url, jsLikely };
  } catch (e) {
    return { ok: false, status: 0, error: String(e).slice(0, 200), jsLikely: true };
  }
}

/* ---------- B: Browser Run ---------- */
async function visitWithBrowser(env, url) {
  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    const clicked = await clickConfirm(page);
    if (clicked) await page.waitForNetworkIdle({ idleTime: 800, timeout: 8000 }).catch(() => {});

    const text = await page.evaluate(() => (document.body?.innerText || "").slice(0, 4000));
    const ok = SUCCESS_RE.test(text) && !FAIL_RE.test(text);
    return { ok, status: 200, finalUrl: page.url(), clicked, snippet: text.slice(0, 160) };
  } catch (e) {
    return { ok: false, status: 0, error: String(e).slice(0, 200) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function clickConfirm(page) {
  const patterns = [/confirm/i, /verify/i, /activate/i, /yes,?\s*(i|confirm)/i, /continue/i, /确认/, /验证/, /激活/];
  const handles = await page.$$("a, button, input[type=submit], [role=button]");
  for (const h of handles) {
    try {
      const label = (await page.evaluate(el => (el.innerText || el.value || "").trim(), h)) || "";
      if (!label || label.length > 60) continue;
      if (patterns.some(p => p.test(label))) { await h.click(); return label; }
    } catch {}
  }
  return null;
}

/* ---------- 公共 ---------- */
async function forwardIfNeeded(message, env) {
  if (!env.FORWARD_TO) return;
  try { await message.forward(env.FORWARD_TO); } catch (e) { console.error("forward failed", e); }
}

async function log(env, message, data) {
  const entry = { at: new Date().toISOString(), from: message.from, to: message.to, ...data };
  console.log(JSON.stringify(entry));
  try {
    await env.CONFIRM_LOG.put("log:" + Date.now() + ":" + Math.random().toString(36).slice(2, 8),
      JSON.stringify(entry), { expirationTtl: 1209600 });
  } catch {}
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
