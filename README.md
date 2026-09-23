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
| Storage | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT` | Dùng cho upload và preview media. |
| Account API | `ACCOUNT_API_URL`, `ACCOUNT_API_KEY` | Tùy chọn; API key chỉ nằm ở backend, không gửi ra browser. |
| Google Drive | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_FRONTEND_CALLBACK_URL`, `GOOGLE_TOKEN_ENCRYPTION_KEY` | Cần khi bật kết nối và import Google Drive. |

Khi API chạy trong container còn PostgreSQL hoặc Redis chạy trực tiếp trên cùng
máy chủ, dùng hostname `host.docker.internal` trong URL. Compose đã ánh xạ
hostname này tới host:

```dotenv
DATABASE_URL=postgres://user:password@host.docker.internal:5432/aggo
REDIS_URL=redis://:password@host.docker.internal:6379
```

## Docker

Compose chạy hai service `api` và `worker`, cùng đọc biến runtime từ `.env`.
Sau khi chuẩn bị các dịch vụ phụ thuộc và `.env`, build image, chạy migration
rồi khởi động các service:

```bash
cp .env.example .env
docker compose build
docker compose run --rm api node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js
docker compose up -d
```

Xem log hoặc dừng service:

```bash
docker compose logs -f api worker
docker compose down
```

Giới hạn tài nguyên được cấu hình qua `.env`: `API_MEMORY_LIMIT`, `API_CPUS`,
`WORKER_MEMORY_LIMIT` và `WORKER_CPUS`.

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

Worker development có thể chạy độc lập:

```bash
yarn worker
yarn worker:outbox
yarn worker:media
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
