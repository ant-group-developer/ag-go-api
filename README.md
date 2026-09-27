# AG Go API

Backend API của AG Go, xây dựng bằng NestJS, PostgreSQL, Redis/BullMQ và
Cloudflare R2. Repository này là một Git repository độc lập.

## Chức năng hiện có

- Xác thực Auth0 JWT, RBAC và proxy Account API.
- Quản lý project, folder/ACL, category, country, province và tag.
- Media của project: attach metadata, sắp xếp, chọn thumbnail, upload trực tiếp
  lên R2 và tạo preview/thumbnail qua worker.
- Google Drive OAuth, import snapshot và hàng đợi import.
- Render profile/batch, download job, audit log, thống kê và system settings.
- OpenAPI/Swagger, request ID, JSON structured log và transactional outbox.

API contract tĩnh được lưu tại [`openapi.yaml`](openapi.yaml).

## Yêu cầu

- Node.js 22
- Yarn 1.22.22
- PostgreSQL và Redis có thể truy cập từ tiến trình API
- Cloudflare R2 và Auth0 đã được cấu hình

Toàn bộ biến môi trường runtime được kiểm tra khi khởi động. Sao chép
`.env.example` thành `.env` và điền các giá trị bắt buộc trước khi chạy.

```bash
cp .env.example .env
yarn install
yarn migration:run
yarn start:dev
```

API mặc định chạy tại `http://localhost:3000/api`.

- Health check: `GET /api/health`
- Swagger UI: `http://localhost:3000/api/docs`
- OpenAPI JSON: `http://localhost:3000/api/openapi.json`

PostgreSQL local trong `.env.example` dùng port `55432` để tránh xung đột với
PostgreSQL trên máy phát triển. Redis, PostgreSQL, R2 và Auth0 không được tạo
bởi Docker Compose chính của repository; hãy cung cấp các dịch vụ này trước
khi chạy API.

## Cấu hình môi trường

| Nhóm | Biến chính | Ghi chú |
|---|---|---|
| Runtime | `PORT`, `API_PREFIX`, `FRONTEND_ORIGIN` | Origin phải khớp URL frontend để CORS hoạt động. |
| Database/queue | `DATABASE_URL`, `DATABASE_SCHEMA`, `REDIS_URL` | Bắt buộc cho API, worker và migration. |
| Auth | `AUTH0_ISSUER_URL`, `AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID`, `AUTH0_JWKS_URL` | Auth0 JWT là bắt buộc ở mọi môi trường. |
| Storage | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT` | Dùng cho upload và preview media. |
| Account API | `ACCOUNT_API_URL`, `ACCOUNT_API_KEY` | Tùy chọn; API key chỉ nằm ở backend, không gửi ra browser. |
| Google Drive | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `FRONTEND_ORIGIN`, `GOOGLE_TOKEN_ENCRYPTION_KEY` | Cần khi bật kết nối và import Google Drive. Callback sẽ quay lại URL của trang khởi tạo kết nối. |

Khi API chạy trong container còn PostgreSQL hoặc Redis chạy trực tiếp trên cùng
máy chủ, dùng hostname `host.docker.internal` trong URL. Compose đã ánh xạ
hostname này tới host:

```dotenv
DATABASE_URL=postgres://user:password@host.docker.internal:5432/aggo
REDIS_URL=redis://:password@host.docker.internal:6379
```

## Docker

Compose chạy service `api` và hai worker, cùng đọc biến runtime từ `.env`:

| Service | Role | Việc xử lý |
|---|---|---|
| `worker-media` | `media` | Render preview/thumbnail bằng FFmpeg/Sharp (nặng CPU) |
| `worker-io` | `download,import,outbox` | Tạo ZIP tải xuống (stream thẳng lên R2), import Google Drive, dispatch outbox event |
Sau khi chuẩn bị các dịch vụ phụ thuộc và `.env`, build image, chạy migration
rồi khởi động các service:

```bash
cp .env.example .env
docker compose build
docker compose run --rm api node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js
docker compose up -d
```

Khi deploy lại trên VPS, dùng `deploy.sh` thay cho `docker compose up -d` (chạy trong
`tmux`/`screen`). Script build, chạy migration, thay `api` trước rồi mới thay worker, nên
API không phải ngừng trong lúc worker cũ chờ job đang chạy xong (tối đa
`WORKER_STOP_GRACE_PERIOD`). Đặt `SKIP_MIGRATION=1` để bỏ qua migration.

```bash
./deploy.sh
```

Xem log hoặc dừng service:

```bash
docker compose logs -f api worker-media worker-io
docker compose down
```

Giới hạn tài nguyên được cấu hình qua `.env`: `API_MEMORY_LIMIT`, `API_CPUS` và
`WORKER_{MEDIA,IO}_MEMORY_LIMIT` / `WORKER_{MEDIA,IO}_CPUS`.

## Scaling workers (host phụ)

Để tăng throughput, chạy các worker (`worker-media` và `worker-io`) trên thêm VPS riêng với cùng DB/Redis, bằng `deploy-worker-host.sh`. Lợi chính là render (`worker-media`). `worker-io` thêm được số ZIP download chạy song song; import Google Drive vẫn chạy lần lượt từng batch và outbox rất nhẹ, nên hai phần này chủ yếu thêm dự phòng khi host khác chết.

Lần đầu trên VPS mới (đã cài Docker + plugin Compose và buildx, `util-linux` cho `flock`):

```bash
git clone <repo> && cd ag-go-api
cp .env.example .env   # điền như .env của host chính, nhưng DATABASE_URL/REDIS_URL trỏ IP private của host chính
```

Mỗi lần deploy, GitHub Actions tự làm: sau khi host chính deploy xong (`deploy.prod.yml` / `deploy.dev.yml`), job `deploy-workers` (`deploy-worker-hosts.yml`) SSH song song vào từng host phụ, checkout **đúng commit host chính vừa chạy** và chạy `deploy-worker-host.sh`. Một host lỗi không chặn các host khác.

Cấu hình (GitHub → Settings → Secrets and variables → Actions):
- Variable `WORKER_HOSTS` (prod) / `WORKER_HOSTS_DEV` (dev): mảng JSON, bỏ trống hoặc `[]` thì không deploy host phụ:
  ```json
  [
    { "name": "worker-1", "host": "203.0.113.10", "user": "deploy", "port": 22, "path": "/opt/ag-go-api", "ssh_key_secret": "WORKER_1_SSH_KEY" },
    { "name": "worker-2", "host": "203.0.113.11", "user": "deploy", "ssh_key_secret": "WORKER_2_SSH_KEY" }
  ]
  ```
  `name`, `port` (mặc định 22), `path` (mặc định `/opt/ag-go-api`), `ssh_key_secret` không bắt buộc. Thêm/bớt host chỉ cần sửa biến này (và thêm secret key của host mới).
- Secret SSH key cho từng host (repository secret, tab Secrets): tên tùy ý, ghi đúng tên đó vào `ssh_key_secret` của host (vd. `WORKER_1_SSH_KEY`), giá trị là private key đầy đủ. Không đưa key vào JSON: variable không mã hóa. Host không có `ssh_key_secret` dùng secret `WORKER_SSH_KEY` (prod) / `WORKER_SSH_KEY_DEV` (dev). Phải là **repository secret**, không phải environment secret (job deploy host phụ không chạy trong environment). Public key tương ứng nằm trong `authorized_keys` của `user`, và `user` chạy được `sudo` không cần mật khẩu. Thiếu secret thì job của host đó báo rõ tên secret thiếu.

Deploy tay (vd. host mới, sau khi host chính đã deploy cùng commit):

```bash
git pull --ff-only origin main && sudo bash ./deploy-worker-host.sh
```

Script:
- Kiểm tra `.env` (URL không trỏ localhost/`host.docker.internal`, `MEDIA_WORKER_ENABLED=true`, CPU), từ chối nếu host có container `api` (host chính dùng `./deploy.sh`) hoặc đang có lần deploy khác chạy.
- Build image `ag-go-api:<commit>` (không đọc được commit thì dừng, không lặng lẽ dùng `latest`).
- Chạy thử image mới trước khi đụng worker đang chạy (`src/workers/worker-host-preflight.ts`, chỉ đọc): kết nối Postgres/Redis, đồng hồ lệch DB ≤ 5 phút, migration phải **khớp** DB (DB thiếu → deploy host chính trước; DB mới hơn → `git pull` đúng commit host chính), và `.env` dùng đúng giá trị của host chính: `QUEUE_PREFIX` (có queue trong Redis), R2 (thấy được object thật), Google key (giải mã được token đang lưu). Sai mấy giá trị này không chỉ làm lỗi mà gây hại: key Google sai làm kết nối Drive của user bị đánh dấu phải kết nối lại, R2 sai làm fail mọi file import trên host đó, prefix khác thì job render đi vào queue không ai đọc.
- Thay `worker-media` và `worker-io` (worker cũ làm xong job đang chạy mới dừng; chạy trong tmux/screen), kiểm tra từng container sống; lỗi thì hướng dẫn dừng worker của host (host chính vẫn chạy), rollback chỉ khi host chính cũng chạy commit đó.
- Giữ image hiện tại + image trước đó (để rollback), xóa các image cũ hơn.

**Quy tắc:**
- Host bổ sung chỉ chạy worker (`worker-media`, `worker-io`); không chạy `api`, không chạy migration.
- An toàn khi chạy nhiều host: render job có `claim_token`; mọi lượt quét job treo (render, import) so với giờ DB; outbox giữ event đang publish bằng lease 5 phút (claim từng lượt, publish chạy nền nên purge dài không chặn render); chỉ process API dọn upload session hết hạn.
- Rủi ro còn lại: hai host có thể bắt đầu hai batch import cùng lúc (không trùng file, chỉ không còn "lần lượt từng batch"); một host mất kết nối Postgres/Redis > 2 phút mà vẫn copy Drive→R2 có thể làm một file import hai lần; purge project chạy > 5 phút có thể bị một poll khác chạy lại song song (xóa trùng, vô hại).
- Reach Redis/Postgres qua private network (WireGuard, Tailscale, or provider VPN); **không public**.
- Chạy migration (từ một host) trước khi deploy version worker mới.
- Nâng cấp mọi worker đang chạy (host chính: `./deploy.sh`) lên version này **trước** khi bật host bổ sung: worker cũ không kiểm tra `claim_token` và quét job treo theo giờ máy, chạy lẫn với worker mới vẫn có thể làm trùng.
- Giữ NTP bật (`timedatectl status`): ký request R2 và delay/backoff của BullMQ vẫn dùng giờ máy; preflight từ chối lệch > 5 phút.

**Tuning throughput:**
- `MEDIA_WORKER_CONCURRENCY`: số job song song trên một worker (bắt buộc; `.env.example`: `2`)
- `MEDIA_FFMPEG_THREADS`: thread cho FFmpeg mỗi job (keep: `concurrency × threads ≈ CPUs`)
- `WORKER_MEDIA_CPUS` / `WORKER_MEDIA_MEMORY_LIMIT`: Docker resource limit (host phụ: tới số CPU − 1 − `WORKER_IO_CPUS`, chừa 1 CPU và 1–2 GB RAM cho OS và lúc build image cạnh worker đang chạy)
- `WORKER_IO_CPUS` / `WORKER_IO_MEMORY_LIMIT`: cho `worker-io` (mặc định 1 CPU, 1g; chủ yếu chờ mạng)
- `DATABASE_POOL_MAX` (api, mặc định 10) / `WORKER_DATABASE_POOL_MAX` (mỗi worker, mặc định 5): số kết nối Postgres mỗi process. Tổng mọi process trên mọi host phải < `max_connections` của Postgres (mặc định 100): host chính 10 + 5 + 5, mỗi host phụ thêm 10. Preflight cảnh báo khi host sắp thêm vượt giới hạn. Tăng `MEDIA_WORKER_CONCURRENCY` lớn (> ~6) thì tăng `WORKER_DATABASE_POOL_MAX` theo.
- `LOG_MAX_SIZE` / `LOG_MAX_FILE`: log container xoay vòng (mặc định 50m × 5 file mỗi container).
- `WORKER_STOP_GRACE_PERIOD`: host phụ không có API nên có thể đặt dài (vd. `20m`) để deploy không cắt ngang render 4K dài; job bị cắt sẽ được sweep đưa lại hàng đợi sau 3 phút và render lại từ đầu

## Lệnh thường dùng

```bash
yarn build
yarn typecheck
yarn lint
yarn format:check
yarn test
yarn openapi:generate
yarn openapi:validate
yarn migration:run
yarn migration:revert
```

Worker development có thể chạy độc lập. `yarn worker` chạy tất cả role trong một
process; tham số role nhận danh sách phân tách bằng dấu phẩy
(`media`, `download`, `import`, `outbox`):

```bash
yarn worker
yarn worker:media
yarn worker:download
yarn worker:io
yarn worker:outbox
```

## CI/CD

Các workflow trong `.github/workflows` kiểm tra format, typecheck, lint, test,
build, OpenAPI và Docker image cho nhánh `main` và `dev`. Push vào `dev` kích
hoạt deploy development; push vào `main` kích hoạt deploy production.

Deploy dùng các secret `VPS_SSH_KEY_DEV`, `VPS_HOST_DEV`, `VPS_USER_DEV`
(tùy chọn `VPS_PORT_DEV`, `VPS_APP_PATH_DEV`) cho development và
`VPS_SSH_KEY`, `VPS_HOST`, `VPS_USER` (tùy chọn `VPS_PORT`, `VPS_APP_PATH`)
cho production. Thông báo Telegram dùng `TELEGRAM_CHAT_ID` và
`TELEGRAM_TOKEN`.
