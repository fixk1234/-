# FXXKLOST 프로필 사이트

```
fxxklost-site/
├─ index.html             ← 사이트 본체 (이 파일만 호스팅하면 됨)
├─ database.rules.json    ← Firebase Realtime Database 보안 규칙
└─ collector/
   ├─ worker.js           ← 활동 수집기 (Cloudflare Worker, 1분마다 자동 실행)
   └─ wrangler.toml
```

## 왜 수집기가 필요한가요?
예전 방식은 **방문자 브라우저가 페이지를 열어둔 동안만** 활동을 기록했어요(localStorage).
이제는 Cloudflare Worker가 1분마다 Lanyard에서 Discord 상태를 확인해서 Firebase에 기록해요.

- 페이지를 아무도 열어두지 않아도 기록돼요
- 모든 방문자에게 같은 기록이 보여요
- "마지막 온라인 확인" 시각도 서버 시간으로 기록해요 (방문자 기기 시간 X)
- 24시간이 지난 기록은 수집기가 삭제하고, 페이지에서도 읽을 때 한 번 더 걸러내요

> 전제: Lanyard가 내 Discord 상태를 볼 수 있어야 해요. (Lanyard Discord 서버 https://discord.gg/lanyard 에 들어가 있어야 함 — 지금 사이트가 이미 동작한다면 이미 된 상태예요.)

---

## 1. Firebase 보안 규칙 적용 (먼저!)
Firebase 콘솔 → Realtime Database → **규칙** 탭에 `database.rules.json` 내용을 붙여넣고 **게시**.

- `activity`, `presence`: 누구나 읽기만 가능, 쓰기는 수집기(서비스 계정)만
- `visitorCount`: 정확히 +1 증가만 허용
- 그 외 경로: 모두 차단

규칙을 적용하기 전에는 페이지에 "기록 서버에 연결하지 못했어요 (읽기 권한 없음)"이 보일 수 있어요.

## 2. 서비스 계정 키 발급
Firebase 콘솔 → ⚙ 프로젝트 설정 → **서비스 계정** → **새 비공개 키 생성** → JSON 다운로드.
JSON 안의 `client_email`, `private_key`를 다음 단계에서 써요.
⚠ 이 JSON은 절대 index.html이나 GitHub에 올리지 마세요.

## 3. 수집기 배포 (Cloudflare 무료 플랜으로 충분)
```bash
cd collector
npx wrangler login
npx wrangler secret put FIREBASE_CLIENT_EMAIL   # client_email 붙여넣기
npx wrangler secret put FIREBASE_PRIVATE_KEY    # private_key 전체(-----BEGIN ... END-----) 붙여넣기
npx wrangler secret put MANUAL_KEY              # (선택) 수동 실행 주소 보호용 아무 문자열
npx wrangler deploy
```

## 4. 동작 확인
- 브라우저에서 `https://fxxklost-collector.<내계정>.workers.dev/?key=<MANUAL_KEY>` 를 열면 한 번 실행되고 `{"ok":true,...}` 가 나와요.
- Firebase 콘솔 데이터 탭에 `activity/meta/lastRun`이 1분마다 바뀌면 성공.
- 사이트의 ACTIVITY 패널 아래에 "마지막 수집 방금"이 보여요.
- 로그: `npx wrangler tail`

## 기록 방식
| 항목 | 방식 |
|---|---|
| 세션 구분 | 활동 종류 + 애플리케이션 ID (없으면 이름) — 동시에 여러 활동이 있어도 쪼개지지 않음 |
| 시간 계산 | 관측된 시작~마지막 관측 시각. 임의 가산 없음. 1분 미만은 "1분 미만" |
| 일시적 누락 | 150초 안에 다시 보이면 같은 세션으로 이어짐. 상태 확인 실패만으로는 세션을 끊지 않음 |
| 24시간 | 경계에 걸친 기록은 24시간 시점부터 잘라서 합산 |
| 합계 | "실제로 활동한 시간"(겹친 시간 1번만)과 "각각 더한 합계"를 따로 표시 |
| LIVE | 수집기가 150초 안에 봤고, 실시간 Lanyard 상태에도 있을 때만 |

## 사이트 수정 포인트
- 곡 아티스트: `index.html`의 `PLAYLIST`에서 `artist:''`를 채우면 곡명 옆에 표시돼요.
- 배포 주소가 정해지면 `<head>`의 canonical / og:url 주석을 풀고 주소를 바꿔주세요.
- 공유 미리보기 이미지(og:image)는 1200×630 이미지를 직접 호스팅해서 바꾸는 걸 추천해요.
- 음원·이미지는 GitHub raw 주소를 그대로 쓰고 있어요. 서비스용이라면 정적 호스팅(Cloudflare Pages, Firebase Hosting 등)으로 옮기는 걸 권장하고, 공개 사용 권한도 확인해 주세요.
