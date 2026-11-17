# Caching audit — findings tracker

This PR is a tracker **and** the place the fixes land: every finding below was reproduced against the running stack (backend + Vite + real Redis + real OneDrive folder), and each one is a checkbox. Fixes are committed **directly to this branch**, one commit per item where practical, and the matching checkbox is ticked in this body as each item is closed. No separate branches, no throwaway PRs — the diff here is the audit plus its remediation, item by item.

Everything below is measured data, not code reading. Reproduction commands are in **Reproduction toolbox** so a fresh session can re-verify each claim.

## Checklist

- [ ] **1 · Admin cache-invalidation buttons delete nothing (double prefix)** — **P0**
- [ ] **2 · `invalidate/courses` pattern `courses_*` matches no real key** — P1
- [ ] **3 · `invalidateCache('requests','pending')` misses the real key** — P1
- [ ] **4 · Settings cache invalidated before `batch.commit()` → stale re-cache for 15 min** — P1
- [ ] **5 · Redis failure is not graceful — requests 500 after an 8s timeout** — P1
- [ ] **6 · `GET /api/user/:username` always 500 → the 30s user cache is dead code** — P2
- [ ] **7 · `group_photos_links` is one global key → cross-session download failure** — P2
- [ ] **8 · An empty gallery is cached forever** — P2
- [ ] **9 · In-memory `settingsCache` is never invalidated by cache routes** — P2
- [ ] **10 · `cache.get(key, true)` "expired cache" fallback can never fire** — P3
- [ ] **11 · `img_<name>` never expires; cache only written on a successful fetch** — P3
- [ ] **12 · `retryCount >= 3` permanently kills an entry** — P3
- [ ] **13 · Logout clears `localStorage` but leaves `sessionStorage._k`; `flushAll` is not atomic** — P3
- [ ] **14 · `image_links_<paths>` key cardinality + no invalidation** — P3
- [ ] **15 · `TREE_CACHE` (in-process) never expires** — info
- [ ] **16 · Edge-cache worker returns `MISS` for curl traffic** — info

Items 1–5 are the ones that actually cost visitors stale data or failed requests; 15–16 are informational and need no fix.

---

## 1 · Admin cache-invalidation buttons delete nothing — **P0**

<details>
<summary>Context</summary>

`backend/utils/cache.utils.js:4` → `backend/config/cache.js` → driven through the Settings page UI (`frontend/src/pages/admin/SettingsPage.jsx:82` `handleCacheInvalidation`, buttons at `:324-340`, gated on a password field holding `JWT_SECRET`).

Two functions disagree about who owns the key prefix:

```js
// backend/config/cache.js:104  keys()
async keys(pattern = '*') {
  pattern = KEY_PREFIX + pattern;      // returns FULL keys: 'jain_convocation_portal:settings_all'
  return await this.redis.keys(pattern);
}

// backend/config/cache.js:85   del()
async del(keys) {
  keys = Array.isArray(keys) ? keys.map(k => KEY_PREFIX + k) : KEY_PREFIX + keys;
  //                          ↑ re-prefixes keys that keys() already prefixed
  return await this.redis.del(...keys);
}
```

So `cacheRoutes` (`:43-45`, `:66-70`, `:91-96`, `:117-119`) issues `DEL jain_convocation_portal:jain_convocation_portal:settings_all` — a key that does not exist — and the response message uses `keys.length` (matched) instead of the delete count (`cache.del` return value, discarded), so the UI reports success on a no-op.
</details>

<details>
<summary>Reproduction</summary>

Warm two settings keys, call the route, read Redis on the server (ground truth, not the app's view):

```bash
curl -s -o /dev/null http://localhost:5000/api/settings/config      # settings_config
curl -s -H "Authorization: Bearer $TOK" http://localhost:5000/api/admin/settings   # settings_all
curl -s "http://localhost:5000/api/cache/invalidate/settings?key=<JWT_SECRET>"
ssh ju_jery bash -s <<< 'REDISCLI_AUTH=$(…) redis-cli keys "jain_convocation_portal:settings*"'
```

</details>

<details>
<summary>Data</summary>

| step | app response | Redis (`redis-cli keys`, db 0) |
|---|---|---|
| warm | — | `settings_all ttl=897`, `settings_config ttl=743` |
| `invalidate/settings` | `{"success":true,"message":"Cleared 1 settings cache keys","keys":["jain_convocation_portal:settings_config"]}` | still present, `ttl=893`, `ttl=739` (counting down, not reset) |
| `invalidate/courses` | "Cleared 3 courses cache keys" | `course_folders`, `course_images_…`, all 3 `gdrive_folders_*` still present |
| `invalidate/settings` (UI) | "Cleared 2 settings cache keys" | both keys still present |
| `invalidate/key/settings_all` | "Cleared cache key: settings_all" | key gone ✔ |
| `invalidate/all` | "All cache cleared successfully" | `🧹 Flushed 5 keys with prefix jain_convocation_portal: (db=0)`, keys gone ✔ |

Isolated check of the wrapper itself:

```js
keys()  → ["jain_convocation_portal:settings_config","jain_convocation_portal:settings_all"]
del(keys()) → deleted count: 0
keys() again → both still present
```

Backend log right after the failed invalidate: `📦 Serving cached settings for category: config` — the cache is still serving, so nothing was cleared anywhere.
</details>

<details>
<summary>Result</summary>

All four scope buttons (`settings`, `courses`, `requests`, `users`) are **silent no-ops that always report success**. Only `/invalidate/all` (scan + pipeline del) and `/invalidate/key/:key` (single unprefixed key) actually delete.

Practical consequence: an admin who hits "Invalidate Settings" or "Invalidate Courses" after uploading photos still gets cached listings/settings for the full TTL (900s / 300s) and sees the old state.

**Fix sketch:** make `del()` accept keys from `keys()` (detect prefix, or add `delRaw()`), and report the delete count instead of `keys.length`.
</details>

---

## 2 · `invalidate/courses` pattern matches no real key — P1

<details>
<summary>Context</summary>

`backend/routes/cacheRoutes.js:66-67`:

```js
const courseKeys  = await cache.keys('courses_*');
const gdriveKeys  = await cache.keys('gdrive_folders_*');
```

The keys actually written by `backend/services/gdrive.js` are:
- `course_folders` (`:87`)
- `course_images_${day}_${time}_${batch}` (`:114`)
- `gdrive_folders_${parentId}` (`:70`)
- `image_links_${paths.join(',')}` (`:146`)

`courses_*` (plural) never matches `course_folders` / `course_images_*` (singular `course_`).
</details>

<details>
<summary>Data</summary>

Observed key set after warming structure + gallery + settings:

```
jain_convocation_portal:course_folders                                   ttl=295
jain_convocation_portal:course_images_18-11-2026_Morning Session_Left     ttl=147
jain_convocation_portal:course_images_18-11-2026_Morning Session_Right   ttl=296
jain_convocation_portal:gdrive_folders_1Yr0d0h0yKtmuqaV7qtCHxSCGOmr2OYtO ttl=292
jain_convocation_portal:gdrive_folders_1Nhd9VbtKJlt4LUU2prnSnn92Gck5M8f4 ttl=293
jain_convocation_portal:gdrive_folders_1bTk3jFN9zVz_Yzmz33JJiP1Trfvxe58O ttl=294
jain_convocation_portal:image_links_18-11-2026/Morning Session/Left/0D7A4445 1.JPG ttl=148
```

Even once item 1 is fixed, `courses_*` would match **zero** of the six `course_*` keys above; only the three `gdrive_folders_*` would drop. `image_links_*` is never covered by any scope button.
</details>

<details>
<summary>Result</summary>

"Invalidate Courses" is a double bug: the no-op prefix bug **and** a wrong pattern. Fixing item 1 alone still leaves session listings and download links cached. Pattern should be `course_*` plus `course_folders` plus `image_links_*` (or the keys should be renamed to match the pattern the route expects).
</details>

---

## 3 · Requests invalidation misses the real key — P1

<details>
<summary>Context</summary>

Write path, `backend/services/request.js:54-55` (`handleImageRequest`, inside the Firestore transaction):

```js
await invalidateCache("requests", "pending");
if (requestType == REQUEST_TYPES.HARDCOPY) await invalidateCache();  // flushAll
```

`backend/utils/cache.utils.js:9-12` deletes `requests_pending` and `all_requests`.

Read path, `backend/services/request.js:71`:

```js
const cacheKey = `requests_${statusFilter.sort().join('_')}_${includeSoftcopy}`;
```

The dashboard requests `status=pending&status=approved&status=printed` (`frontend/src/pages/admin/AdminPage.jsx:70`), so the real key is `requests_approved_pending_printed_false`. `requests_pending` and `all_requests` **never exist**; `all_requests` appears in no writer at all.
</details>

<details>
<summary>Reproduction</summary>

```bash
curl -s -H "Authorization: Bearer $TOK" \
  "http://localhost:5000/api/admin/requests?status=pending&status=approved&status=printed"   # writes the key
node -e "require('dotenv').config(); const {cache}=require('./config/cache'); const {invalidateCache}=require('./utils/cache.utils');
  (async()=>{ console.log('before:', await cache.keys('requests_*'));
    await invalidateCache('requests','pending');
    console.log('after:',  await cache.keys('requests_*'));
    console.log('all_requests:', await cache.get('all_requests')); })()"
```

</details>

<details>
<summary>Data</summary>

```
before: ["jain_convocation_portal:requests_approved_pending_printed_false"]
after:  ["jain_convocation_portal:requests_approved_pending_printed_false"]   ← unchanged
all_requests deleted? undefined                                                ← key never existed
```

Redis TTL observed for that key: `ttl=296` of `TTL.REQUESTS = 300`.

Also observed: `requests_*` keys disappear on their own after 300s (no invalidation involved), and `GET /api/admin/requests` logs `📦 Serving cached requests` on repeat calls.
</details>

<details>
<summary>Result</summary>

A student submitting a request does **not** invalidate the admin dashboard list — it stays stale for the full 300s. Hard-copy requests accidentally work, because `invalidateCache()` with no type falls through to `flushAll` (`cache.utils.js:17-18`), wiping everything including settings and structure.

**Fix sketch:** derive the key from the same formula as the reader (invalidate by filter set + `includeSoftcopy`), or use a pattern delete (`requests_*`) instead of a fixed name. Drop the phantom `all_requests`.
</details>

---

## 4 · Settings cache invalidated before `batch.commit()` — P1

<details>
<summary>Context</summary>

`backend/services/settings.js:41-48`:

```js
for (const [category, categorySettings] of Object.entries(settings)) {
  const docRef = db.collection("settings").doc(category);
  await invalidateCache(`settings`, category);   // ← cache dropped FIRST
  batch.set(docRef, categorySettings);
}
await batch.commit();                            // ← Firestore written AFTER
updateSettingsCache(settings);
// await invalidateCache("settings");            ← commented out at :49
```

Any `GET /settings/config` (public, no auth, `backend/routes/adminRoutes.js:62`) landing in the gap between the drop and the commit reads the **pre-commit** Firestore state and re-caches it with `TTL.SETTINGS = 900`.
</details>

<details>
<summary>Reproduction</summary>

Fire a stream of config reads while the settings POST runs:

```js
const pump = async () => { while(!stop){ stream.push(await cfg()); } };   // cfg() = GET /api/settings/config
const p = pump();
await fetch('/api/admin/settings', {method:'POST', headers:{Authorization:'Bearer '+tok,…});
await new Promise(r=>setTimeout(r,250)); stop = true; await p;
```

</details>

<details>
<summary>Data</summary>

Aggressive run (25 GETs fired before the POST, 25 concurrent with it):

```
GETs during save: 3   distinct stamps: ["OLD"]
redis settings_config stamp: OLD(stale cached)   ttl: 899
served right after save: OLD
```

Firestore had the new stamp (`GET /api/admin/settings/config`, same cache path, and the Settings page caption) while Redis held the **old** stamp with a fresh 900s TTL — so visitors keep getting the old config until it expires.

First, gentler run did **not** reproduce (`redis settings_config stamp: undefined ttl: -2`, served NEW) — the window is timing-dependent, which is why this needs a stress test rather than a single save.

Note: `invalidateCache('settings', category)` (`cache.utils.js:13-15`) deletes `settings_<category>` **and** `settings_all` with unprefixed keys, so this one path does work correctly (unlike item 1).
</details>

<details>
<summary>Result</summary>

Confirmed race: a save can leave a poisoned settings cache for 15 minutes. Not every save hits it, so it presents as an intermittent "the setting didn't take effect" bug — which is exactly the symptom class this audit is about.

**Fix sketch:** invalidate after `batch.commit()`, or write-through (set the cache to the new value post-commit) instead of dropping-then-re-reading.
</details>

---

## 5 · Redis failure is not graceful — P1

<details>
<summary>Context</summary>

`backend/config/cache.js` wraps every op in `try/catch` and returns `undefined`/`false` on error (`:48-56`, `:67-79`), which looks like graceful degradation. But `redisClient` is configured with:

```js
retryStrategy: (times) => Math.min(times * 50, 2000),   // :19-22
maxRetriesPerRequest: 3,                                 // :23
```

and `getCourseFolders` has a hard budget (`backend/services/gdrive.js:101`, `timeoutMs = 8000`, comment says it's sized for Vercel's 10s limit). A fresh structure fetch calls `cache.get` per folder level (`_getFolders`, `:71`), so failed Redis calls multiply inside one 8s budget.
</details>

<details>
<summary>Reproduction</summary>

Temp env change (untracked file, reverted after): replace `REDIS_PASSWORD` in `backend/.env` with a wrong value, restart `node index.js`, then hit endpoints.
</details>

<details>
<summary>Data</summary>

Startup: `Server running on port 5000` then `❌ Redis connection error: WRONGPASS invalid username-password pair or user is disabled.` — process does **not** crash.

Requests:

| endpoint | with Redis working | with Redis broken |
|---|---|---|
| `GET /api/courses` | cold 5.47s, cached 0.24s | **500** at 8.58s / 8.22s / 8.16s (all three attempts) |
| `GET /api/settings/config` | ~1.06s cached | 200 at **2.93s** |
| first `/api/courses` after restart | — | 200 (5.47s), then two 500s |

Log pattern:

```
❌ FetchStructureFailed: { error: 'Folder fetch timeout - try again or check cache' }
Cache get error for key jain_convocation_portal:gdrive_folders_…: WRONGPASS …
Cache get error for key jain_convocation_portal:settings_config: Reached the max retries per request limit (which is 3)
Cache set error for key jain_convocation_portal:gdrive_folders_…: WRONGPASS …
✅ Redis connected successfully      ← repeated ~12 times (reconnect loop, misleading log)
❌ Redis connection error: WRONGPASS …
```

After restoring the password: `courses 200 5.470s` (cold, Drive fetch) → `courses 200 0.245s` (cached) → `config 200 1.062s`, keys re-populated (`course_folders ttl=295`, `settings_all ttl=886`, `settings_config ttl=896`).
</details>

<details>
<summary>Result</summary>

Cache failure becomes **request failure**: `/api/courses` returns 500 on every attempt once the Redis retry backoffs consume the 8s fetch budget, instead of serving fresh Drive data. This is the worst failure mode for a 17k-visitor event: a Redis outage takes the sessions page down rather than degrading it.

Also: `✅ Redis connected successfully` fires on every reconnect attempt, so the log reads like a healthy connection while requests fail.

**Fix sketch:** bound Redis waiting (small `maxRetriesPerRequest`, or a short timeout around `cache.get/set`) so cache misses fall through to Drive immediately; treat auth failure as terminal instead of retrying forever.
</details>

---

## 6 · `GET /api/user/:username` always 500 → dead user cache — P2

<details>
<summary>Context</summary>

`backend/routes/userRoutes.js:3` imports only what it uses for login/feedback:

```js
const { authenticateUser, updateUserFeedback } = require('../services/user');
```

`backend/routes/userRoutes.js:41` calls a third function that was never imported:

```js
const userdata = await getUserData(username);   // ReferenceError
```

`getUserData` exists and is exported (`backend/services/user.js:51`, `:142`) and is the only place `TTL.USER_DATA = 30` (`backend/config/cache.js:8`) is used (`services/user.js:67`).
</details>

<details>
<summary>Data</summary>

Three consecutive calls:

```
GET /api/user/ADMIN → 500 "Error getting user data"   ×3
```

Backend log:

```
❌ GetUserError: { username:'ADMIN', error:'getUserData is not defined',
  stack:'ReferenceError: getUserData is not defined\n    at …userRoutes.js:41:22' }
```

Redis: **no `user_*` key ever appears** in any scan across the whole session — the cache path is unreachable. `invalidate/users` (`cacheRoutes.js:117`) therefore always reports 0 keys.

Frontend grep for `/api/user/` → **no callers** (`frontend/src/**` has zero matches), so no UI feature depends on it; the endpoint is dead for both reasons.
</details>

<details>
<summary>Result</summary>

The endpoint is broken (always 500) and unused. Either wire it up (import `getUserData`) or delete the route + the `USER_DATA` TTL + the `invalidate/users` button. Until then, any claim that user data is cached for 30s is false.
</details>

---

## 7 · `group_photos_links` is one global key → cross-session download failure — P2

<details>
<summary>Context</summary>

`frontend/src/pages/GalleryPage.jsx:146-181`. The download-link cache is keyed by a **constant string**, not per session:

```js
const cached = localStorage.getItem('group_photos_links');
const TTL = 1 * 24 * 60 * 60 * 1000; // 1 day
…
localStorage.setItem('group_photos_links', JSON.stringify({ data: links, timestamp: Date.now() }));
…
const link = links.links.find(l => l.name === imagePath);
if (link) await window.open(link.download, '_self');
```

Real Drive has no `Group Photos` batch today (only `18-11-2026 / Morning Session / Left, Right`), and the download UI only renders for `isGroupPhotos` (`:54`, `:238`), so this was driven with mocked gallery/link responses. Note: `agent-browser network route` mocks only apply to same-origin requests, so a temp Vite proxy `/api → :5000` + `API_BASE_URL: '/api'` was used (reverted afterwards).
</details>

<details>
<summary>Data</summary>

Session A (`18-11-2026/Morning Session/Group Photos`, mocked image `A1.JPG`):

```
/api/images requests: 1   → http://localhost:5173/api/images/A1.JPG 200
localStorage keys: ["…gallery-<A>-refresh-stamp", "group_photos_links", "…gallery-<A>"]
group_photos_links.data.links: [{name:"A1.JPG", download:"http://localhost:5173/a1.jpg"}]
```

Session B (`18-11-2026/Evening Session/Group Photos`, mocked image `B1.JPG`), same browser, cache still fresh:

```
/api/images requests: 0        ← links reused from session A
other /api requests: none
url stayed /gallery/<B>
group_photos_links.names: ["A1.JPG"]   ← unchanged, B's path absent
```

`links.find(name === 'B1.JPG')` → `undefined` → the `if (link)` branch is skipped → **silent no-download**, no error, no request.
</details>

<details>
<summary>Result</summary>

A visitor who downloads from one Group Photos session can never download from a second one for 24 hours, and gets no feedback at all. The key must be per-session (e.g. `group_photos_links-<sessionId>`), or the cached payload must be keyed by path with a miss → fetch path.
</details>

---

## 8 · An empty gallery is cached forever — P2

<details>
<summary>Context</summary>

`frontend/src/utils/cache.js:13` — TTL is looked up by the **exact** key:

```js
const CACHE_CONFIG = { courses: {ttl: 60_000}, gallery: {ttl: 60_000} };
const ttl = CACHE_CONFIG[key]?.ttl;
```

The gallery key is `gallery-${sessionId}` (`GalleryPage.jsx:113`), so `CACHE_CONFIG[key]` is `undefined` → `ttl` undefined → the entry never expires (intentional cache-first, protected by the forced-refresh stamp). The consequence nobody considered: `cacheManager.get()` returns `[]`, which is **truthy**, so an empty listing wins over the backend forever.

`frontend/src/pages/CoursesPage.jsx:102` has a guard the gallery lacks:

```js
if (sortedData && sortedData.length > 0) { setStructure(sortedData); cacheManager.set('courses', sortedData, isRetry); }
```
</details>

<details>
<summary>Data</summary>

Empty-listing case, driven by seeding localStorage (value `[]`, stamp equal to config stamp):

```
fetches on load: 0
url: /gallery/<id>
cached entry: []            ← empty array served, not refetched
```

CoursesPage with an empty mocked response:

```
localStorage.cached: null   ← length>0 guard refuses to cache
cards rendered: 0
courses GETs on reload: 1   ← refetches (preflight OPTIONS + GET = 2 entries in HAR)
```

Real Drive batch sizes for reference: Left = 5 images, Right = 70 images (`✅ FetchCourseImages … count: 5` / `count: 70`). The README alert ("photos may take ~45 minutes to upload") was visible on the sessions page during the audit — the mid-upload state is exactly this case.
</details>

<details>
<summary>Result</summary>

Asymmetry: CoursesPage never caches an empty structure, GalleryPage caches an empty batch **permanently**. A batch whose photos arrive later stays blank for every visitor until an admin presses *Refresh now*. Fix options: treat `length === 0` as a miss in the gallery, or give `gallery-<sessionId>` a real TTL entry (match the key, not the bare `gallery`).
</details>

---

## 9 · In-memory `settingsCache` is never invalidated by cache routes — P2

<details>
<summary>Context</summary>

There are **two** settings caches, and only one is touched by the admin controls:

- Redis `settings_<category>` (`backend/services/settings.js:8-29`, TTL 900) — what `/settings/config` and `/admin/settings/:category` serve.
- Process-object `settingsCache` (`backend/config/settings.js:3-30`) — used by `services/gdrive.js:29` (`_getShareId` → `getSettings("courses").folderId`) and email creds (`:22-26`), with env fallbacks (`GDRIVE_SHAREID`, `GMAIL_USER`, `GMAIL_APP_PASS`).

`cacheRoutes` never calls `updateSettingsCache`, and `invalidateCache('settings', …)` only removes Redis keys. `updateSettings` refreshes the in-memory object (`services/settings.js:48`), so it only goes stale when Firestore is edited outside the app (console, migration, another deploy).
</details>

<details>
<summary>Data</summary>

Settings document read during the audit:

```json
{"config":{"SHOW_UPLOAD_ALERT":true,"HARDCOPY_DISABLED":false,"REMOVE_HARDCOPY":false,
           "DEMO_MODE":false,"GALLERY_REFRESH_TIMESTAMP":1794930761207},
 "courses":{"folderId":"<drive folder id>"},
 "general":{"gmailAppPass":"<redacted>","gmailUser":"<gmail acct>"},
 "payment":{"upiId":"<redacted>","amount":"500","upiLink":"upi://pay?…"}}
```

After `/api/cache/invalidate/all` (`🧹 Flushed 5 keys … db=0`), `GET /api/courses` still returned the live structure — Drive folder lookups kept using the in-memory `folderId`, proving the flush does not reset this layer.

Also note the env/Firestore split: `backend/.env` `GDRIVE_FOLDERID` points at last year's folder (`19-11-2025 Day 1`), while the app reads the folder from Firestore (`1Yr0d0…` → `18-11-2026`). `config/settings.js` falls back to `GDRIVE_SHAREID`, which is not the variable name in `.env` (`GDRIVE_FOLDERID`) — so that fallback can never fire.
</details>

<details>
<summary>Result</summary>

"Invalidate All Cache" clears Redis but leaves the running process serving an old Drive folderId / Gmail creds. Any external Firestore change needs a restart. Worth either wiring `invalidate` → `updateSettingsCache` re-read, or documenting that the in-memory layer needs a restart.
</details>

---

## 10 · `cache.get(key, true)` expired-cache fallback can never fire — P3

<details>
<summary>Context</summary>

`backend/services/request.js:102-105` (error path of `getAllRequests`):

```js
const expiredCache = await cache.get(cacheKey, true);
if (expiredCache) { console.log('⚠️ Serving expired cache due to error'); return expiredCache; }
```

`backend/config/cache.js:45` states plainly: `@param {boolean} returnExpired - Not used in Redis (node-cache compatibility)` — Redis `SETEX` deletes expired keys outright, so there is nothing to return.
</details>

<details>
<summary>Data</summary>

```js
await cache.set('probe_expired','x',1);      // TTL 1s
await sleep(1600);
await cache.get('probe_expired')      → undefined
await cache.get('probe_expired', true) → undefined
```

`⚠️ Serving expired cache` never appeared in the backend log during the whole audit.
</details>

<details>
<summary>Result</summary>

Dead fallback path: if the Firestore query fails (e.g. missing composite index — the code prints an index hint at `:94-98`), the admin dashboard gets an error rather than last-known data. Implementing it needs a shadow key (`…:expired`) kept past TTL, or drop the branch and stop implying a safety net that doesn't exist.
</details>

---

## 11 · `img_<name>` never expires; cache written only on success — P3

<details>
<summary>Context</summary>

`frontend/src/pages/admin/AdminPage.jsx:172` and `:186`:

```js
data.links.forEach(link => { localStorage.setItem(`img_${link.name}`, link.download); });
…
const cachedUrl = localStorage.getItem(`img_${path}`);
if (cachedUrl) await downloadFile(cachedUrl, path, 500);
else { const links = await getImageLinks(Object.keys(requestImages)); … }
```

A bare string — no timestamp, no TTL, no size limit. Only cleared by `logout()` (`AuthContext.jsx:41`, `localStorage.clear()`). Keys embed the full path, so they contain spaces and can be long (`img_18-11-2026/Morning Session/Left/DDS01051.JPG`).
</details>

<details>
<summary>Data</summary>

Real request on the dashboard: `test001 / TEST1 / Hard Copy / pending`, `requestedImages` and `hardcopyImages` both `["18-11-2026/Morning Session/Left/DDS01051.JPG"]`.

First download attempt (no cache entry):

```
GET /api/images/18-11-2026/Morning%20Session/Left/DDS01051.JPG → 500
backend: ❌ FetchImageLinksFailed: { error: 'File not found' }   (gdrive.js:172)
snackbar: "Error downloading image"
localStorage keys after: []            ← nothing cached, because getImageLinks threw before :172 ran
```

Second attempt with a seeded cache entry (`img_…` = a live thumbnail URL):

```
/api/images requests on download: 0
other /api requests: none
localStorage keys after: ["img_18-11-2026/Morning Session/Left/DDS01051.JPG"]   ← untouched, no refresh
snackbar: (none)
```

So the cached branch works; the write branch is skipped on failure, meaning a permanent error is retried every click, and a successful entry is never revisited.
</details>

<details>
<summary>Result</summary>

Two-sided problem: stale Drive links persist indefinitely for every request an admin ever downloads (unbounded accumulation across thousands of students until logout), while failures are never cached and re-hit Drive on every click. The `File not found` case here is data drift — the request references a file that is no longer in that batch — which the cache layer can't detect.
</details>

---

## 12 · `retryCount >= 3` permanently kills an entry — P3

<details>
<summary>Context</summary>

`frontend/src/utils/cache.js:16-17`:

```js
if (retryCount >= 3 || (ttl && Date.now() - timestamp > ttl)) { localStorage.removeItem(key); return null; }
```

`set(key, value, retry)` at `:29-30` increments only when an entry already exists:

```js
const retryCount = retry && existing ? JSON.parse(existing).retryCount + 1 : 0;
```
</details>

<details>
<summary>Reproduction + Data</summary>

Injected entry with `retryCount: 3` (fresh timestamp) on `/sessions`:

```
courses fetches on reload: 1        ← cache treated as dead
entry after reload: {"value":[ … real structure …], "retryCount": 0}   ← rewritten fresh
```

Corrupt entry (`localStorage.setItem('courses','{not json')`):

```
courses fetches on reload: 1
errors after corrupt entry: (none)   ← get()'s catch swallows it, page fine
```

Also verified: `GET /api/courses` retry path (`CoursesPage.jsx:97`) and `GalleryPage.jsx:129-132` — a failed gallery fetch retries once with `isRetry=true` and then redirects to `/sessions`.
</details>

<details>
<summary>Result</summary>

Behaviour is safe (no crash) but means an entry can become permanently uncached while the app keeps rewriting it with `retryCount: 0` on success — the counter only ever climbs if a *successful* fetch happens after a retry. Fine as a guard; worth knowing that `retryCount >= 3` entries never recover by themselves.
</details>

---

## 13 · Logout clears `localStorage` but leaves `sessionStorage._k`; `flushAll` is not atomic — P3

<details>
<summary>Context</summary>

`frontend/src/config/AuthContext.jsx:38-42`:

```js
const logout = () => { … secureStorage.clear(); localStorage.clear(); };
```

`secureStorage.clear()` removes only `_auth` (`:106-110`); `cipher.key` lives in `sessionStorage._k` (`:119-125`) and is never removed. The "encryption" is a XOR-salt over that key (`:130-137`) — obfuscation, not crypto.

`backend/config/cache.js:118-135` `flushAll` uses `scanStream({match: KEY_PREFIX+'*', count: 500})` + pipeline deletes.
</details>

<details>
<summary>Data</summary>

Logout from `/admin`:

```
before: ls=["gallery-<id>-refresh-stamp","gallery-<id>"]  ss=["_auth","courses-page-ui","_k"]
after:  url=/login  ls=[]                                 ss=["courses-page-ui","_k"]
```

All gallery caches and stamp keys wiped ✔; `_auth` gone ✔; `_k` survives (key material persists for the tab) and `courses-page-ui` (expanded-day UI state) persists by design.

flushAll under traffic:

```
keys before flush: 7 → after flush: 1        (first run)
keys before flush: 5 → after flush: 0        (clean run, `🧹 Flushed 6 keys`)
keys before flush: 7 → after flush: 6        (another run, `🧹 Flushed 3 keys`)
```

Keys written by concurrent requests during the scan survive a response that says "All cache cleared successfully".
</details>

<details>
<summary>Result</summary>

Logout correctly wipes every gallery/courses cache (so cache-first restarts after re-login). Two caveats: `_k` lingering is harmless but means the obfuscation salt outlives the session, and `flushAll` needs a re-scan (or `KEYS` snapshot + delete) if you want it to be exhaustive while requests are in flight. Redis db 0 is shared with `bull:face-search:*` keys (dbsize 22 vs our ~7), so the prefix-scoped flush matters — it correctly leaves queue keys alone.
</details>

---

## 14 · `image_links_<paths>` key cardinality + no invalidation — P3

<details>
<summary>Context</summary>

`backend/services/gdrive.js:146`:

```js
const cacheKey = `image_links_${fullPaths.join(",")}`;
```

The key is the concatenation of every requested path (spaces and slashes included), TTL 300 (`TTL.COURSES`), one Drive `files.list` per image inside `Promise.all` (`:152-175`). No scope button covers it (see item 2).
</details>

<details>
<summary>Data</summary>

Observed key, verbatim:

```
jain_convocation_portal:image_links_18-11-2026/Morning Session/Left/0D7A4445 1.JPG ttl=148
```

Repeat download of the same single path:

```
1st: ℹ️ FetchingImageLinks { count: 1 } → ✅ ImageLinksFetched
2nd: 📦 Serving cached Links           → ✅ ImageLinksFetched     ← cache hit
```

But any *different* combination of paths is a new key (the gallery requests all paths at once, `GalleryPage.jsx:173`, the admin requests all images of a request, `AdminPage.jsx:191`), so cardinality grows with every distinct selection set, and each key stores full `webViewLink`/`webContentLink` payloads.
</details>

<details>
<summary>Result</summary>

Works for repeats, but the key space is effectively unbounded (one key per path-combination, per batch) and nothing invalidates it. A per-path key (`image_link_<path>`) would dedupe across selection sets; plus `image_links_*` needs to be part of the courses/settings invalidation scope.
</details>

---

## 15 · `TREE_CACHE` (in-process) never expires — info

<details>
<summary>Context + Data</summary>

`backend/services/gdrive.js:33-65`: `TREE_CACHE = new Map()` keyed `parentId:depth`, holding **promises** of folder trees; cleared only inside `getCourseFolders` on a fresh fetch (`:98`), and deleted on rejection (`:61`). It has no TTL of its own.

Sequence driven with `flushAll`:

```
(warm)      📦 Serving cached sessions
flushAll    🧹 Flushed 5 keys with prefix jain_convocation_portal: (db=0)
next GET    ℹ️ FetchingStructure → ✅ FetchStructure: days=1, times=1, batches=2   ← fresh Drive fetch, TREE_CACHE cleared+refilled
next GET    ℹ️ FetchingStructure → 📦 Serving cached sessions → ✅ FetchStructure  ← Redis hit (getCourseImages calls getCourseFolders again)
```
</details>

<details>
<summary>Result</summary>

`TREE_CACHE` is bounded in practice by Redis `course_folders` (300s) — a fresh fetch clears it, so new/renamed Drive folders appear within ~5 min. Not a bug, but two things to know: folder **ids** are held in process memory indefinitely, and a `getCourseFolders` cache hit never consults or refreshes `TREE_CACHE`, so structure freshness is entirely a Redis-TTL question.
</details>

---

## 16 · Edge-cache worker returns `MISS` for curl traffic — info

<details>
<summary>Context + Data</summary>

`backend/services/gdrive.js:6` `EDGE_CACHE_PROXY ("<cloudflare worker origin>")`, concatenated as `worker/` + `https://lh3.googleusercontent.com/drive-storage/…=s480` (`:138`) — note the doubled slash.

Three curl requests for the same thumbnail URL:

```
HTTP/1.1 200 OK  CF-Cache-Status: MISS  Cache-Control: public, max-age=2592000
HTTP/1.1 200 OK  CF-Cache-Status: MISS  Cache-Control: public, max-age=2592000
HTTP/1.1 200 OK  CF-Cache-Status: MISS  Cache-Control: public, max-age=2592000
```

Browser (agent-browser HAR) for the same URL:

```
first load : 5 requests, ~4906/5064/5065/5066/5067 ms   headers: cache-control=public, max-age=2592000  cf-cache-status=HIT
second load: 5 requests, ~1ms each                       headers: same
```
</details>

<details>
<summary>Result</summary>

The **browser** honours `max-age=2592000` (30 days) — second load ~1ms per image, so image egress is handled client-side. Cloudflare serves HIT for browser traffic but MISS for curl, so the worker's edge cache is not reliably shareable across clients; treat it as best-effort, not the caching mechanism. One consequence worth tracking: a thumbnail URL is only bust-cached by the browser, so a replaced Drive file whose thumbnail URL stays identical would be stale for up to 30 days regardless of the forced-refresh stamp.
</details>

---

## Verified working (no action needed)

<details>
<summary>Frontend localStorage</summary>

- `courses` (TTL 60s): reload inside 1 min → **0** `/api/courses` requests; reload at 65s → **1** request (`✅ FetchStructure`). Entry shape `{value, timestamp, retryCount}` confirmed (`retry: 0`).
- `gallery-<base64>` (no TTL match → never expires): entry aged **105s**, reload → **0** fetches, twice.
- Forced refresh stamp (`GalleryPage.jsx:112`): stamp mismatch → **exactly 1** fetch, stamp key rewritten; next reload → **0** fetches. Also verified the first load after a stamp bump fetches even though the cached entry is intact.
- `cache:'no-store'` on the config fetch (`config.js:19`): server sends `Cache-Control: public, max-age=60` + `ETag W/"93-…"`, yet the browser re-requests `/settings/config` on **every** page load (1 request per reload, body 436 bytes).
- Corrupt JSON and quota-style failures degrade to a refetch with no console errors.
</details>

<details>
<summary>Backend Redis</summary>

- TTLs match `backend/config/cache.js:6-11` exactly: `settings_*` 900 (`ttl=896`, `ttl=469`), `course_folders`/`gdrive_folders_*`/`course_images_*`/`image_links_*` 300 (`ttl=295/294/293/147/148`), `requests_approved_pending_printed_false` 300 (`ttl=296`). Expired keys observed disappearing with no invalidation involved.
- Every cache-hit log path fires at least once in one session: `Serving cached settings` ×75, `sessions` ×6, `images` ×2, `requests` ×2, `Links` ×1.
- Cache is doing real work: cold Drive fetch 5.470s vs cached 0.245s (**~22×**), config 1.06s cached.
- No rate limiter is actually applied (`grep -rn "rateLimit" backend` → no matches, though `express-rate-limit` is a dependency).
- CORS is `cors()` default (`backend/index.js:15`) — `Access-Control-Allow-Origin: *` on every API response, so OPTIONS preflights appear in every HAR window (counts as 2 entries for one logical GET).
</details>

<details>
<summary>Forced gallery refresh feature (merged PR #1/#2)</summary>

`GALLERY_REFRESH_TIMESTAMP` is declared in `staticConfig` (`config.js:7`), rendered as its own Settings row below *Show Upload Alert* with a *Refresh now* button, persisted through the same `POST /api/admin/settings` → Firestore `settings/config` doc, and compared **by value** against the per-entry stamp key (`gallery-<id>-refresh-stamp`) rather than by clock. End-to-end verified twice: bump → 1 fetch → cached again. The admin tab sees the new stamp without a page reload (`refreshConfig()` swaps `configReadyPromise`, `config.js:57-62`).
</details>

---

## Reproduction toolbox

<details>
<summary>Redis ground truth (server, via ssh)</summary>

```bash
ssh ju_jery bash -s <<'EOF'
PW=$(echo <sudo-pass> | sudo -S awk '/^requirepass/{print $2}' /etc/redis/redis.conf 2>/dev/null | tail -1)
export REDISCLI_AUTH="$PW"
redis-cli keys 'jain_convocation_portal:*' | sort | while read k; do echo "$k ttl=$(redis-cli ttl "$k")"; done
EOF
```

Use `redis-cli keys`, not `--scan --pattern`, and don't pipe through `tail` — `--scan` plus a truncating `tail` made key counts look wrong (reported 5 where `keys` showed 7). Redis 8.10, db 0, shared with `bull:face-search:*`.
</details>

<details>
<summary>Per-test network evidence</summary>

`agent-browser network har start --content none` … `network har stop <file>`, then count entries per URL with `node -e "JSON.parse(fs.readFileSync(...)).log.entries.filter(...)"` (`.har` is JSON — `require()` on it fails). Timings and response headers in the HAR are what distinguished browser-cache hits (~1ms) from network fetches (~5000ms).
Gotchas found: `network route` mocks apply **only to same-origin** requests (cross-origin mocks produce "Failed to fetch"); `unroute "*"` does **not** remove pattern-specific routes registered via `batch`, so stale routes silently win; `agent-browser eval` shares page scope, so re-declaring `const c` throws "Identifier already declared"; `reload` right after `click` (login) races and silently fails.
</details>

<details>
<summary>Running the stack</summary>

```bash
pnpm install --allow-build protobufjs        # backend
pnpm install --allow-build esbuild --allow-build @vercel/speed-insights   # frontend
node index.js            # backend, port 5000
pnpm run dev             # vite, port 5173 (README says 3000; the script is plain vite)
```

`pnpm` 12 fails the install with `ERR_PNPM_IGNORED_BUILDS` unless those build scripts are approved; the flags write `pnpm-workspace.yaml` (`allowBuilds`) into each package dir — those files are generated, untracked, and were deleted at the end of the audit. Node is v26.12.1.

Cache routes need `?key=<JWT_SECRET>` (`cacheRoutes.js:8-19`). Test accounts: **ADMIN / 12345678** works; **TEST006** no longer exists (`❌ LoginFailed: InvalidCredentials`) — `scripts/seedTestUsers.js` needs `SEED_TEST_USERS=true` and writes into Firestore collection `2025` (not run during the audit). Login endpoint is `/api/login`, not `/api/auth/login`.
</details>

<details>
<summary>Environment fixes made during the audit (untracked files only)</summary>

- `backend/.env` `REDIS_PASSWORD` was stale (17 chars → `WRONGPASS`); replaced with the server's 12-char `requirepass`. This is gitignored, so nothing here is a code change.
- Root `package.json`: `start:queue` removed and `init` trimmed to backend+frontend only (face-search excluded for this session). **Uncommitted** by design.
- An orphaned `node` process kept port 5000 bound after the background task died — killing it was required before a restart could bind (kill by port owner, not by task).
</details>
