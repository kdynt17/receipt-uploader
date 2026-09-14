# 영수증 제출함

학교 계정 사용자에게서 이름과 영수증 파일을 받아 담당자의 비공개 Google Drive에 저장하는 소형 웹앱입니다.

## 구조

1. GitHub Pages에는 공개 안내문과 제출 시작 링크만 둡니다.
2. 실제 폼은 도메인 제한된 Google Apps Script HTML Service에서 제공합니다.
3. Apps Script가 파일을 서버에서 다시 검사한 뒤 앱 전용 Drive 폴더에 무작위 이름으로 저장합니다.
4. 접수 기록은 같은 비공개 폴더의 Google Sheet에 저장되고, 30일 뒤 파일과 행이 영구 삭제됩니다.

이름과 파일은 GitHub로 전송되지 않습니다. 외부 글꼴, 분석 도구, 광고, 쿠키 또는 브라우저 저장소를 사용하지 않습니다.

## 수집·보관

- 수집: 이름, 영수증 파일, 제출 시각
- 저장: 담당자 계정의 비공개 Drive 폴더
- 미수집: 앱 차원의 이메일, IP, 원본 파일명, 브라우저 정보
- 파일명: `receipt_<무작위 UUID>.<확장자>`
- 허용 형식: PDF, JPEG, PNG
- 최대 크기: 8MB
- 무결성 확인: SHA-256 기록
- 보관 기간: 30일
- 삭제: 시간 기반 트리거가 Drive 파일을 영구 삭제하고 식별 가능한 접수 행도 제거

Google, GitHub, 네트워크 사업자 또는 Google Workspace 관리자는 각자의 정책에 따른 접속 기록이나 백업을 보유할 수 있습니다. 절대적인 무유출이나 물리적 즉시 삭제를 보장하는 표현은 사용하지 않습니다.

## Apps Script 설치

1. 독립 실행형 Apps Script 프로젝트를 만듭니다.
2. `apps-script/Code.gs`, `apps-script/Index.html`, `apps-script/appsscript.json`을 프로젝트에 복사합니다.
3. `setupReceiptApp`을 한 번 실행하고 권한을 승인합니다.
4. 웹 앱으로 새 배포합니다.
   - 실행 사용자: 배포자
   - 액세스 사용자: 배포자와 같은 Google Workspace 도메인의 사용자
5. `/exec` URL을 `docs/index.html`의 `__APPS_SCRIPT_URL__` 자리에 넣습니다.

Apps Script 프로젝트는 명시적으로 다음 최소 범위를 요청합니다.

- 앱이 만들거나 연 파일만 관리하는 `drive.file`
- 접수 Sheet를 쓰는 `spreadsheets`
- 30일 삭제 트리거를 만드는 `script.scriptapp`

## 운영 점검

- Drive 폴더를 공개 또는 링크 공유로 바꾸지 않습니다.
- 담당자 Google/GitHub 계정에 2단계 인증을 사용합니다.
- 담당자가 바뀌면 Apps Script를 새 담당자 계정에서 다시 배포합니다.
- 보관 기간이나 허용 파일 형식을 바꾸면 안내문과 코드를 함께 수정합니다.
- 제출자 요청으로 조기 삭제할 때는 접수번호로 Sheet 행과 Drive 파일을 찾아 모두 삭제합니다.

## 로컬 확인

`docs/`를 정적 서버로 열어 안내 페이지의 반응형 레이아웃과 링크를 확인할 수 있습니다. 실제 업로드 폼은 Apps Script 배포 환경에서만 동작합니다.

