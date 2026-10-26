/**
 * FXXKLOST 활동 수집기 — Cloudflare Worker (Cron: 1분마다)
 * 페이지를 아무도 열어두지 않아도 Discord 상태(Lanyard)를 확인해서 Firebase RTDB에 기록합니다.
 *
 * 기록 구조 (index.html이 읽는 형식과 동일)
 *   activity/open/{key}     진행 중 활동 { key,name,type,application_id,details,state,start,lastSeen }
 *   activity/sessions/{id}  끝난 활동   { key,name,type,application_id,details,state,start,end }
 *   activity/meta           { lastRun, lastOkAt, lastErrorAt, lastError }
 *   presence/lastOnline     온라인을 실제로 관측한 마지막 서버 시각
 *
 * 필요한 시크릿 (wrangler secret put ...)
 *   FIREBASE_DB_URL           예) https://ff123-2bd41-default-rtdb.firebaseio.com
 *   FIREBASE_CLIENT_EMAIL     서비스 계정 client_email
 *   FIREBASE_PRIVATE_KEY      서비스 계정 private_key (-----BEGIN PRIVATE KEY----- 포함 전체)
 *   DISCORD_USER_ID           1489458472826441901
 */

export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const CLOSE_AFTER_MS = 150 * 1000; // 이 시간 동안 안 보이면 활동 종료로 처리 (한두 번의 일시적 누락은 무시)
const ONLINE = ['online', 'idle', 'dnd'];

/* index.html의 sanitizeKey / activityKey 와 반드시 같아야 함 */
export function sanitizeKey(s){ return String(s).replace(/[.#$\[\]\/\u0000-\u001f\u007f]/g, '_').slice(0, 120); }
export function activityKey(a){ return sanitizeKey(a.type + '_' + (a.application_id || a.name)); }
const clip = (s, n) => (s == null ? '' : String(s).slice(0, n));

function resolveStatus(d){
  if(ONLINE.includes(d.discord_status)) return d.discord_status;
  if(d.active_on_discord_desktop || d.active_on_discord_web || d.active_on_discord_mobile) return 'online';
  return d.discord_status === 'offline' ? 'offline' : 'unknown';
}

/**
 * 순수 함수: 현재 저장 상태 + Lanyard 응답 → Firebase 다중 경로 업데이트
 * lanyard === null 이면 상태 확인 실패 (이 경우 오래 안 보인 활동만 마지막 관측 시각에서 종료)
 */
export function computeUpdates(activity, lanyard, now, errorMsg){
  const open = (activity && activity.open) || {};
  const sessions = (activity && activity.sessions) || {};
  const u = {};
  const closeAt = (k, o, end) => {
    u['activity/open/' + k] = null;
    if(end - o.start >= 1000){
      u['activity/sessions/' + k + '_' + o.start] = {
        key:k, name:o.name, type:o.type, application_id:o.application_id || null,
        details:o.details || null, state:o.state || null, start:o.start, end
      };
    }
  };

  u['activity/meta/lastRun'] = now;

  if(!lanyard){
    u['activity/meta/lastErrorAt'] = now;
    u['activity/meta/lastError'] = clip(errorMsg || 'unknown', 200);
    for(const k of Object.keys(open)){
      if(now - open[k].lastSeen > CLOSE_AFTER_MS * 4) closeAt(k, open[k], open[k].lastSeen);
    }
  }else{
    u['activity/meta/lastOkAt'] = now;
    const status = resolveStatus(lanyard);
    if(ONLINE.includes(status)) u['presence/lastOnline'] = now;

    const current = new Map();
    if(status !== 'offline'){
      for(const a of lanyard.activities || []){
        if(!a || !a.name || a.type === 4) continue;      // 4 = 사용자 지정 상태 메시지
        current.set(activityKey(a), a);
      }
    }
    for(const [k, a] of current){
      const prev = open[k];
      if(prev){
        u['activity/open/' + k + '/lastSeen'] = now;
        u['activity/open/' + k + '/details'] = clip(a.details, 120) || null;
        u['activity/open/' + k + '/state'] = clip(a.state, 120) || null;
      }else{
        /* Discord가 알려준 시작 시각이 있으면 사용 (단, 최근 24시간·최근 기록 이후로 제한해 중복 방지) */
        let start = now;
        const ts = a.timestamps && Number(a.timestamps.start);
        if(ts && ts < now && ts > now - WINDOW_MS) start = ts;
        for(const s of Object.values(sessions)){
          if(s.key === k && s.end > start - 1) start = Math.max(start, s.end);
        }
        u['activity/open/' + k] = {
          key:k, name:clip(a.name, 100), type:Number(a.type) || 0,
          application_id:a.application_id || null,
          details:clip(a.details, 120) || null, state:clip(a.state, 120) || null,
          start:Math.min(start, now), lastSeen:now
        };
      }
    }
    for(const k of Object.keys(open)){
      if(current.has(k)) continue;
      const o = open[k];
      if(status === 'offline' || now - o.lastSeen > CLOSE_AFTER_MS) closeAt(k, o, o.lastSeen);
    }
  }

  /* 24시간이 지난 기록은 서버에서도 삭제 */
  for(const id of Object.keys(sessions)){
    if(Number(sessions[id].end) < now - WINDOW_MS) u['activity/sessions/' + id] = null;
  }
  return u;
}

/* ---------------- Firebase 인증 (서비스 계정 → OAuth 액세스 토큰) ---------------- */
let cachedToken = null;
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlStr = (s) => b64url(new TextEncoder().encode(s));

async function getAccessToken(env){
  if(cachedToken && cachedToken.exp > Date.now() + 60000) return cachedToken.token;
  const pem = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['sign']);
  const iat = Math.floor(Date.now() / 1000);
  const head = b64urlStr(JSON.stringify({ alg:'RS256', typ:'JWT' }));
  const body = b64urlStr(JSON.stringify({
    iss:env.FIREBASE_CLIENT_EMAIL,
    scope:'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud:'https://oauth2.googleapis.com/token', iat, exp:iat + 3600
  }));
  const sig = b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + body)));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST',
    headers:{ 'content-type':'application/x-www-form-urlencoded' },
    body:'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + body + '.' + sig
  });
  if(!res.ok) throw new Error('토큰 발급 실패 HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  cachedToken = { token:j.access_token, exp:Date.now() + (j.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

async function db(env, method, path, body){
  const token = await getAccessToken(env);
  const url = env.FIREBASE_DB_URL.replace(/\/$/, '') + '/' + path + '.json?access_token=' + encodeURIComponent(token);
  const res = await fetch(url, {
    method, headers:{ 'content-type':'application/json' },
    body:body === undefined ? undefined : JSON.stringify(body)
  });
  if(!res.ok) throw new Error('Firebase ' + method + ' ' + path + ' HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return res.json();
}

async function fetchLanyard(env){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try{
    const res = await fetch('https://api.lanyard.rest/v1/users/' + env.DISCORD_USER_ID, { signal:ctrl.signal, headers:{ 'cache-control':'no-cache' } });
    if(!res.ok) throw new Error('Lanyard HTTP ' + res.status);
    const j = await res.json();
    if(!j || j.success !== true || !j.data || !j.data.discord_user) throw new Error('Lanyard 응답 형식 오류');
    return { data:j.data };
  }catch(err){
    return { error:String(err && err.message || err) };
  }finally{ clearTimeout(t); }
}

export async function runOnce(env){
  const now = Date.now();
  const [activity, lan] = await Promise.all([db(env, 'GET', 'activity'), fetchLanyard(env)]);
  const updates = computeUpdates(activity, lan.data || null, now, lan.error);
  await db(env, 'PATCH', '', updates);
  return { ok:!lan.error, error:lan.error || null, writes:Object.keys(updates).length };
}

export default {
  async scheduled(event, env, ctx){
    ctx.waitUntil(runOnce(env).catch((err) => console.error('수집 실패:', err)));
  },
  /* 브라우저로 Worker 주소를 열면 상태 확인용으로 한 번 실행 (선택: ?key=MANUAL_KEY 로 보호) */
  async fetch(req, env){
    const url = new URL(req.url);
    if(env.MANUAL_KEY && url.searchParams.get('key') !== env.MANUAL_KEY) return new Response('forbidden', { status:403 });
    try{
      const r = await runOnce(env);
      return Response.json(r);
    }catch(err){
      return Response.json({ ok:false, error:String(err.message || err) }, { status:500 });
    }
  }
};
