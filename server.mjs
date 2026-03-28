import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "http";
import { execFileSync } from "child_process";
import { randomBytes, createHash } from "crypto";
import { readFileSync } from "fs";
import { z } from "zod";
import "dotenv/config";

// === CONFIG ===

const BB = process.env.BB_BROWSER_PATH || (process.env.HOME + "/local/bin/bb-browser");
const PORT = parseInt(process.env.PORT || "8080");
const CDP_PORT = process.env.CDP_PORT || "9222";
const BASE_URL = process.env.BASE_URL || "http://localhost:8080";
const VERSION = "0.6.0";
const DM_PIN = process.env.DM_PIN || "";

if (DM_PIN && !/^\d{4}$/.test(DM_PIN)) {
  console.error("Error: DM_PIN must be exactly 4 digits"); process.exit(1);
}

const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || "twitter-mcp-client";
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || randomBytes(32).toString("hex");
var registeredRedirectUris = [];
const authCodes = new Map();   // code -> { expires, codeChallenge, redirectUri }
const accessTokens = new Map(); // token -> expiresAt

// Cleanup expired auth codes and tokens every 60s
setInterval(function() {
  var now = Date.now();
  for (var [k, v] of authCodes) { if (v.expires < now) authCodes.delete(k); }
  for (var [k, v] of accessTokens) { if (v < now) accessTokens.delete(k); }
}, 60000);

// === BROWSER HELPERS ===

function bbDirect(...bbArgs) {
  var args = ["--port", CDP_PORT].concat(bbArgs);
  try { return execFileSync(BB, args, { encoding: "utf-8", timeout: 30000 }).trim(); }
  catch (e) { return "Error: " + (e.stderr || e.message || "").substring(0, 500); }
}
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function isTwitterUrl(s) {
  try { var u = new URL(s); return /^https?:$/.test(u.protocol) && /^(.*\.)?(x\.com|twitter\.com)$/.test(u.hostname); }
  catch { return false; }
}

function jsStr(s) { return JSON.stringify(String(s)); }

var MAX_TABS = 10;
function cleanupTabs() {
  try {
    var list = bbDirect("tab", "list");
    var m = list.match(/共 (\d+) 个/);
    if (m && parseInt(m[1]) > MAX_TABS) {
      var count = parseInt(m[1]);
      for (var i = count - 1; i >= 1 && count - i < count - MAX_TABS + 2; i--) {
        bbDirect("tab", "close", String(i));
      }
    }
  } catch(e) {}
}

// === SHARED TWEET PARSER ===
// Single source of truth: open URL -> wait -> parse tweet articles from DOM
// Used by: timeline, search, bookmarks, tweets

function parseTweetsJS(cnt) {
  return '(function(){ var tweets=[]; var articles=document.querySelectorAll(\'article[data-testid="tweet"]\'); for(var i=0;i<Math.min(articles.length,' + cnt + ');i++){ var a=articles[i]; var user=a.querySelector(\'[data-testid="User-Name"]\'); var text=a.querySelector(\'[data-testid="tweetText"]\'); var time=a.querySelector("time"); var imgs=Array.from(a.querySelectorAll(\'[data-testid="tweetPhoto"] img\')).map(function(x){return x.src}); var link=a.querySelector(\'a[href*="/status/"]\'); tweets.push({user:user?user.textContent:"",text:text?text.textContent:"",time:time?time.getAttribute("datetime"):"",images:imgs,url:link?"https://x.com"+link.getAttribute("href"):""}); } return JSON.stringify(tweets); })()';
}

async function openAndParseTweets(url, count, waitMs) {
  cleanupTabs();
  bbDirect("open", url);
  await sleep(waitMs || 4000);
  return bbDirect("eval", parseTweetsJS(count || 20));
}

// === GRAPHQL API HELPER ===
// Used by: like, retweet, undo (no page navigation needed)

function twitterAPI(mutation, tweetId, extraVars) {
  var endpoints = {
    FavoriteTweet: "lI07N6Otwv1PhnEgXILM7A",
    UnfavoriteTweet: "ZYKSe-w7KEslx3JhSIk5LA",
    CreateRetweet: "mbRO74GrOvSfRcJnlMapnQ",
    DeleteRetweet: "ZyZigVsNiFO6v1dEks1eWg",
    DeleteTweet: "nxpZCY2K-I6QoFHAHeojFQ",
  };
  var id = endpoints[mutation];
  if (!id) return "Error: unknown mutation " + mutation;
  var vars = extraVars || '{"tweet_id":"' + tweetId + '"}';
  return bbDirect("eval", '(async function(){ var ct0=document.cookie.split(";").map(function(c){return c.trim()}).find(function(c){return c.startsWith("ct0=")}).split("=")[1]; var r=await fetch("/i/api/graphql/' + id + '/' + mutation + '",{method:"POST",credentials:"include",headers:{"authorization":"Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA","x-csrf-token":ct0,"content-type":"application/json"}, body:JSON.stringify({variables:' + vars + ',queryId:"' + id + '"})}); return r.ok?"ok: "+r.status:"error: "+r.status+" "+await r.text().then(function(t){return t.substring(0,200)}); })()');
}

function extractTweetId(url) {
  var m = url.match(/status\/(\d+)/);
  return m ? m[1] : "";
}

// === BB-SITES HELPER ===
// Still used by: notifications, user (these adapters work reliably for now)

function ensureOnTwitter() {
  var check = bbDirect("eval", '(function(){ return window.location.hostname; })()');
  if (!check.includes("x.com")) {
    bbDirect("open", "https://x.com/home");
    for (var i = 0; i < 5; i++) {
      var r = bbDirect("eval", '(function(){ return document.readyState; })()');
      if (r.includes("complete")) break;
    }
  }
}

// === DM HELPERS ===

function dmPinJS() {
  return '(function(){ var inputs=document.querySelectorAll("input[type=\\"text\\"]"); if(inputs.length<4) return "no_pin"; var pin=' + jsStr(DM_PIN) + '; for(var i=0;i<4;i++){ var inp=inputs[i]; inp.focus(); var ns=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set; ns.call(inp,pin[i]); inp.dispatchEvent(new Event("input",{bubbles:true})); inp.dispatchEvent(new Event("change",{bubbles:true})); inp.dispatchEvent(new KeyboardEvent("keydown",{key:pin[i],code:"Digit"+pin[i],bubbles:true})); inp.dispatchEvent(new KeyboardEvent("keyup",{key:pin[i],code:"Digit"+pin[i],bubbles:true})); } return "pin_entered"; })()';
}

function dmConvoListJS() {
  return '(function(){ var items=document.querySelectorAll("[data-testid*=\\"dm-conversation-item\\"]"); var list=[]; for(var i=0;i<items.length;i++){ var it=items[i]; list.push({id:it.getAttribute("data-testid"),preview:it.textContent.trim().substring(0,200)}); } return JSON.stringify(list); })()';
}

function dmClickConvoJS() {
  // Normal click() doesn't work on Twitter DM items - need full pointer event sequence
  return '(function(){ var item=document.querySelector("[data-testid*=\\"dm-conversation-item\\"]"); if(!item) return "no conversation"; var rect=item.getBoundingClientRect(); var x=rect.left+200; var y=rect.top+rect.height/2; ["pointerdown","mousedown","pointerup","mouseup","click"].forEach(function(t){ item.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,view:window})); }); return "clicked"; })()';
}

function dmReadMessagesJS() {
  // Clone text nodes and strip time elements before reading textContent
  return '(function(){ var els=document.querySelectorAll("[data-testid*=\\"message-text\\"]"); var msgs=[]; for(var i=0;i<els.length;i++){ var el=els[i]; var clone=el.cloneNode(true); var times=clone.querySelectorAll("time, [datetime]"); for(var j=0;j<times.length;j++) times[j].remove(); var text=clone.textContent.trim(); var row=el.closest("[data-testid*=\\"message-\\"]"); var time=""; if(row){ var t=row.querySelector("time"); if(t) time=t.getAttribute("datetime")||t.textContent.trim(); } msgs.push({text:text,time:time}); } var user=document.querySelector("[data-testid=\\"dm-conversation-username\\"]"); return JSON.stringify({partner:user?user.textContent.trim():"",url:location.href,messages:msgs}); })()';
}

// ============================================================
// MCP SERVER
// ============================================================

function makeServer() {
  var s = new McpServer({ name: "twitter-bridge", version: VERSION });

  // === WRITE TOOLS ===

  s.tool("twitter_post", "Post a new tweet", { text: z.string() }, async function(p) {
    cleanupTabs();
    bbDirect("open", "https://x.com/home");
    await sleep(3000);
    var snap = bbDirect("snapshot", "-i", "-c", "-d", "6");
    var m = snap.match(/textbox \[ref=(\d+)\] "Post text"/);
    if (!m) return { content: [{ type: "text", text: "Error: compose box not found" }] };
    bbDirect("type", m[1], p.text);
    await sleep(500);
    var r = bbDirect("eval", '(function(){ var b=document.querySelector(\'[data-testid="tweetButtonInline"]\'); if(!b||b.disabled)return "not ready"; b.click(); return "posted"; })()');
    return { content: [{ type: "text", text: r }] };
  });

  s.tool("twitter_reply", "Reply to a tweet", { tweet_url: z.string(), text: z.string() }, async function(p) {
    if (!isTwitterUrl(p.tweet_url)) return { content: [{ type: "text", text: "Error: invalid Twitter URL" }] };
    cleanupTabs();
    bbDirect("open", p.tweet_url);
    var snap, m;
    for (var attempt = 0; attempt < 3; attempt++) {
      await sleep(3000);
      snap = bbDirect("snapshot", "-i", "-c", "-d", "8");
      m = snap.match(/Post your reply[\s\S]*?textbox \[ref=(\d+)\]/);
      if (m) break;
    }
    if (!m) return { content: [{ type: "text", text: "Error: reply box not found" }] };
    bbDirect("type", m[1], p.text);
    await sleep(500);
    var r = bbDirect("eval", '(function(){ var b=document.querySelector(\'[data-testid="tweetButtonInline"]\'); if(!b||b.disabled)return "not ready"; b.click(); return "replied"; })()');
    return { content: [{ type: "text", text: r }] };
  });

  s.tool("twitter_like", "Like a tweet (no page navigation)", { tweet_url: z.string() }, async function(p) {
    if (!isTwitterUrl(p.tweet_url)) return { content: [{ type: "text", text: "Error: invalid Twitter URL" }] };
    var id = extractTweetId(p.tweet_url);
    if (!id) return { content: [{ type: "text", text: "Error: could not extract tweet ID from URL" }] };
    var r = twitterAPI("FavoriteTweet", id);
    return { content: [{ type: "text", text: r.includes("ok") ? "liked" : r }] };
  });

  s.tool("twitter_retweet", "Retweet (no page navigation)", { tweet_url: z.string() }, async function(p) {
    if (!isTwitterUrl(p.tweet_url)) return { content: [{ type: "text", text: "Error: invalid Twitter URL" }] };
    var id = extractTweetId(p.tweet_url);
    if (!id) return { content: [{ type: "text", text: "Error: could not extract tweet ID" }] };
    var r = twitterAPI("CreateRetweet", id);
    return { content: [{ type: "text", text: r.includes("ok") ? "retweeted" : r }] };
  });

  s.tool("twitter_undo", "Undo an action: unlike, unretweet, or delete tweet", {
    tweet_url: z.string(),
    action: z.enum(["unlike", "unretweet", "delete"]).describe("unlike / unretweet / delete")
  }, async function(p) {
    if (!isTwitterUrl(p.tweet_url)) return { content: [{ type: "text", text: "Error: invalid Twitter URL" }] };
    var id = extractTweetId(p.tweet_url);
    if (!id) return { content: [{ type: "text", text: "Error: could not extract tweet ID" }] };
    var map = { unlike: "UnfavoriteTweet", unretweet: "DeleteRetweet", delete: "DeleteTweet" };
    var mutation = map[p.action];
    var vars = p.action === "unretweet" ? '{"source_tweet_id":"' + id + '"}' : undefined;
    var r = twitterAPI(mutation, id, vars);
    return { content: [{ type: "text", text: r.includes("ok") ? p.action + " done" : r }] };
  });

  s.tool("twitter_quote", "Quote tweet - posts on your timeline with embedded tweet card", { tweet_url: z.string(), text: z.string() }, async function(p) {
    if (!isTwitterUrl(p.tweet_url)) return { content: [{ type: "text", text: "Error: invalid Twitter URL" }] };
    cleanupTabs();
    bbDirect("open", "https://x.com/compose/post");
    await sleep(3000);
    var pasteContent = p.text + "\n" + p.tweet_url;
    bbDirect("eval", '(function(){ var t=document.querySelector(\'[data-testid="tweetTextarea_0"]\'); t.focus(); var dt=new DataTransfer(); dt.setData("text/plain",' + jsStr(pasteContent) + '); t.dispatchEvent(new ClipboardEvent("paste",{clipboardData:dt,bubbles:true,cancelable:true})); })()');
    for (var a = 0; a < 5; a++) {
      await sleep(2000);
      var state = bbDirect("eval", '(function(){ var b=document.querySelector(\'[data-testid="tweetButtonInline"]\'); return b&&!b.disabled?"ready":"no"; })()');
      if (state.includes("ready")) break;
    }
    var r = bbDirect("eval", '(function(){ var b=document.querySelector(\'[data-testid="tweetButtonInline"]\'); if(!b||b.disabled)return "not ready"; b.click(); return "quoted"; })()');
    return { content: [{ type: "text", text: r }] };
  });

  s.tool("twitter_follow", "Follow a user", { screen_name: z.string() }, async function(p) {
    var name = p.screen_name.replace(/\W/g, "");
    cleanupTabs();
    bbDirect("open", "https://x.com/" + name);
    await sleep(3000);
    var r = bbDirect("eval", '(function(){ var btns=document.querySelectorAll(\'[role="button"]\'); for(var i=0;i<btns.length;i++){ if(btns[i].textContent.trim()==="Follow"){ btns[i].click(); return "followed @' + name + '"; }} return "follow button not found"; })()');
    return { content: [{ type: "text", text: r }] };
  });

  s.tool("twitter_unfollow", "Unfollow a user", { screen_name: z.string() }, async function(p) {
    var name = p.screen_name.replace(/\W/g, "");
    cleanupTabs();
    bbDirect("open", "https://x.com/" + name);
    await sleep(3000);
    bbDirect("eval", '(function(){ var btns=document.querySelectorAll(\'[role="button"]\'); for(var i=0;i<btns.length;i++){ if(btns[i].textContent.includes("Following")){ btns[i].click(); return; }} })()');
    await sleep(1000);
    var r = bbDirect("eval", '(function(){ var b=document.querySelector(\'[data-testid="confirmationSheetConfirm"]\'); if(!b)return "confirm not found"; b.click(); return "unfollowed @' + name + '"; })()');
    return { content: [{ type: "text", text: r }] };
  });

  // === READ TOOLS ===

  s.tool("twitter_search", "Search tweets", { query: z.string(), count: z.number().optional(), type: z.enum(["latest", "top"]).optional() }, async function(p) {
    var q = encodeURIComponent(p.query);
    var filter = (p.type === 'top') ? '' : '&f=live';
    var r = await openAndParseTweets("https://x.com/search?q=" + q + "&src=typed_query" + filter, p.count || 20);
    return { content: [{ type: "text", text: r }] };
  });

  s.tool("twitter_notifications", "Get your notifications", { count: z.number().optional() }, async function(p) {
    ensureOnTwitter();
    return { content: [{ type: "text", text: bbDirect("site", "twitter/notifications", "--count", String(p.count || 20)) }] };
  });

  s.tool("twitter_bookmarks", "Get your bookmarks", { count: z.number().optional() }, async function(p) {
    var r = await openAndParseTweets("https://x.com/i/bookmarks", p.count || 20);
    return { content: [{ type: "text", text: r }] };
  });

  s.tool("twitter_tweets", "Get a user's tweets", { screen_name: z.string(), count: z.number().optional() }, async function(p) {
    var name = p.screen_name.replace(/\W/g, "");
    var r = await openAndParseTweets("https://x.com/" + name, p.count || 20);
    return { content: [{ type: "text", text: r }] };
  });

  s.tool("twitter_user", "Get a user's profile", { screen_name: z.string() }, async function(p) {
    ensureOnTwitter();
    return { content: [{ type: "text", text: bbDirect("site", "twitter/user", p.screen_name.replace(/\W/g, "")) }] };
  });

  s.tool("twitter_timeline", "Get your home timeline", { count: z.number().optional() }, async function(p) {
    var r = await openAndParseTweets("https://x.com/home", p.count || 20, 3000);
    return { content: [{ type: "text", text: r }] };
  });

  s.tool("twitter_view_tweet", "View a tweet with full details and image URLs", { tweet_url: z.string() }, async function(p) {
    if (!isTwitterUrl(p.tweet_url)) return { content: [{ type: "text", text: "Error: invalid Twitter URL" }] };
    cleanupTabs();
    bbDirect("open", p.tweet_url);
    await sleep(3000);
    var r = bbDirect("eval", '(function(){ var article=document.querySelector(\'article[data-testid="tweet"]\'); if(!article)return JSON.stringify({error:"not found"}); var user=article.querySelector(\'[data-testid="User-Name"]\'); var text=article.querySelector(\'[data-testid="tweetText"]\'); var time=article.querySelector("time"); var imgs=Array.from(article.querySelectorAll(\'[data-testid="tweetPhoto"] img\')).map(function(x){return x.src}); var video=article.querySelector("video"); var likes=article.querySelector(\'[data-testid="like"]\'); var rts=article.querySelector(\'[data-testid="retweet"]\'); return JSON.stringify({user:user?user.textContent:"",text:text?text.textContent:"",time:time?time.getAttribute("datetime"):"",images:imgs,has_video:!!video,likes:likes?likes.textContent.trim():"0",retweets:rts?rts.textContent.trim():"0"}); })()');
    return { content: [{ type: "text", text: r }] };
  });

  s.tool("twitter_screenshot", "Screenshot the current Twitter page", {}, async function() {
    var path = "/tmp/twitter-screenshot.png";
    bbDirect("screenshot", path);
    try {
      var data = readFileSync(path);
      return { content: [{ type: "image", data: data.toString("base64"), mimeType: "image/png" }] };
    } catch(e) {
      return { content: [{ type: "text", text: "Screenshot error: " + e.message }] };
    }
  });

  s.tool("twitter_dm_read", "Read your DM conversations", {}, async function() {
    cleanupTabs();
    bbDirect("open", "https://x.com/messages");
    await sleep(5000);

    // Auto-enter PIN if prompted (PIN interpolated at Node level, not browser)
    var pinResult = bbDirect("eval", dmPinJS());
    if (pinResult.indexOf("pin_entered") >= 0) {
      await sleep(4000);
    }

    // Get conversation list
    var convos = bbDirect("eval", dmConvoListJS());

    // Click first conversation (needs pointer event sequence, not just click())
    var clickResult = bbDirect("eval", dmClickConvoJS());
    if (clickResult.indexOf("no conversation") >= 0) {
      return { content: [{ type: "text", text: JSON.stringify({ conversations: JSON.parse(convos || "[]"), messages: [] }) }] };
    }
    await sleep(4000);

    // Read messages (clone nodes, strip time elements, then read clean text)
    var msgs = bbDirect("eval", dmReadMessagesJS());

    // Return single clean JSON
    try {
      var result = { conversations: JSON.parse(convos || "[]"), chat: JSON.parse(msgs || "{}") };
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch(e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "parse error", raw_convos: convos, raw_msgs: msgs }) }] };
    }
  });

  // === BROWSER TOOLS ===

  s.tool("browser_open", "Open any URL (http/https only)", { url: z.string() }, async function(p) {
    try { var u = new URL(p.url); if (!/^https?:$/.test(u.protocol)) throw 0; }
    catch { return { content: [{ type: "text", text: "Error: only http/https URLs allowed" }] }; }
    cleanupTabs();
    return { content: [{ type: "text", text: bbDirect("open", p.url) }] };
  });

  s.tool("browser_snapshot", "Get current page content", { depth: z.number().optional() }, async function(p) {
    return { content: [{ type: "text", text: bbDirect("snapshot", "-c", "-d", String(p.depth || 5)) }] };
  });

  return s;
}

// ============================================================
// HTTP SERVER + OAUTH
// ============================================================

function parseBody(req, maxBytes) {
  maxBytes = maxBytes || 65536;
  return new Promise(function(resolve, reject) {
    var b = ""; req.on("data", function(c) { b += c; if (b.length > maxBytes) { req.destroy(); reject(new Error("body too large")); } });
    req.on("end", function() { resolve(b); });
  });
}

var httpServer = createServer(async function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  var url = new URL(req.url, "http://localhost:" + PORT);
  console.log(new Date().toISOString() + " " + req.method + " " + url.pathname + (req.headers["authorization"] ? " [auth]" : ""));

  // OAuth discovery
  if (url.pathname === "/.well-known/oauth-protected-resource") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ resource: BASE_URL, authorization_servers: [BASE_URL] })); return;
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      issuer: BASE_URL,
      authorization_endpoint: BASE_URL + "/authorize",
      token_endpoint: BASE_URL + "/token",
      registration_endpoint: BASE_URL + "/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      code_challenge_methods_supported: ["S256", "plain"]
    })); return;
  }

  // OAuth dynamic registration
  if (url.pathname === "/register" && req.method === "POST") {
    var body = JSON.parse(await parseBody(req));
    var uris = body.redirect_uris || [];
    registeredRedirectUris = uris;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      client_name: body.client_name || "claude",
      redirect_uris: uris
    })); return;
  }

  // OAuth authorize (auto-approve, validates redirect_uri)
  if (url.pathname === "/authorize") {
    var rawRedir = url.searchParams.get("redirect_uri");
    if (!rawRedir || (registeredRedirectUris.length > 0 && !registeredRedirectUris.includes(rawRedir))) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_redirect_uri" })); return;
    }
    var redir = new URL(rawRedir);
    var code = randomBytes(32).toString("hex");
    authCodes.set(code, { expires: Date.now() + 300000, codeChallenge: url.searchParams.get("code_challenge"), redirectUri: rawRedir });
    redir.searchParams.set("code", code);
    if (url.searchParams.get("state")) redir.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { Location: redir.toString() }); res.end(); return;
  }

  // OAuth token exchange
  if (url.pathname === "/token" && req.method === "POST") {
    var tbody = new URLSearchParams(await parseBody(req));
    var stored = authCodes.get(tbody.get("code"));
    if (!stored || stored.expires < Date.now()) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant" })); return;
    }
    if (stored.codeChallenge && tbody.get("code_verifier")) {
      if (createHash("sha256").update(tbody.get("code_verifier")).digest("base64url") !== stored.codeChallenge) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" })); return;
      }
    }
    if (stored.redirectUri && tbody.get("redirect_uri") !== stored.redirectUri) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant" })); return;
    }
    authCodes.delete(tbody.get("code"));
    var token = randomBytes(48).toString("hex");
    accessTokens.set(token, Date.now() + 86400000);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 86400 })); return;
  }

  // MCP endpoint
  if (url.pathname === "/mcp") {
    var auth = req.headers["authorization"];
    var tk = auth ? auth.replace("Bearer ", "") : "";
    if (!tk || !accessTokens.has(tk) || accessTokens.get(tk) < Date.now()) {
      if (tk) accessTokens.delete(tk);
      res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
      res.end(JSON.stringify({ error: "unauthorized" })); return;
    }
    var transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    var server = makeServer();
    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(404); res.end("Not found");
});

httpServer.listen(PORT, "0.0.0.0", function() {
  console.log("Twitter MCP Bridge v" + VERSION + ": http://0.0.0.0:" + PORT + "/mcp");
});
