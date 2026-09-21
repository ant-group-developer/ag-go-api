# ag-go-api

Backend/API repository của AG Go.

Xem tài liệu triển khai tại `../docs/07-backend-plan.md` và contract chung tại
`../docs/05-api-contract.md`.

Package manager: Yarn `1.22.22`.

```bash
yarn install
yarn migration:run
yarn start:dev
```

Chạy toàn bộ backend bằng Docker:

```bash
cp .env.example .env
docker compose build
docker compose run --rm api node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js
docker compose up -d
```

Compose chính chỉ chạy `api` và `worker`, lấy toàn bộ biến runtime trực tiếp từ
`.env`. API được publish theo biến `PORT`; `DATABASE_URL` và `REDIS_URL` cũng
được dùng nguyên giá trị trong `.env`, phù hợp với PostgreSQL/Redis đã chạy sẵn
trên VPS. Khi chạy trên VPS, hai URL này phải trỏ tới hostname/IP mà container
có thể truy cập, không dùng `localhost` nếu database nằm ngoài container. Nếu
PostgreSQL/Redis chạy trực tiếp trên cùng VPS, có thể dùng
`host.docker.internal` (Compose đã ánh xạ hostname này tới host):

```dotenv
DATABASE_URL=postgres://user:password@host.docker.internal:5432/aggo
REDIS_URL=redis://:password@host.docker.internal:6379
```

Nếu cần dựng PostgreSQL và Redis local, dùng Compose override:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build -d
docker compose -f docker-compose.yml -f docker-compose.local.yml run --rm api node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js
```

Giới hạn tài nguyên được cấu hình qua `.env`: API/worker mặc định mỗi service
`2 CPU` và `2 GB RAM`; PostgreSQL local mặc định `1 CPU/1 GB`, Redis local
`0.5 CPU/256 MB`.

CI/CD nằm trong `.github/workflows`:

- `ci.yml`: kiểm tra format, typecheck, lint, test, build và Docker image cho
  `main`/`dev`.
- `deploy.dev.yml`: deploy khi push vào `dev`.
- `deploy.prod.yml`: deploy khi push vào `main`.
- `notify.yml`: gửi trạng thái workflow qua Telegram.

Các secret SSH cần khai báo trên GitHub repository: `VPS_SSH_KEY_DEV`,
`VPS_HOST_DEV`, `VPS_USER_DEV`, tùy chọn `VPS_PORT_DEV` và
`VPS_APP_PATH_DEV`; production dùng `VPS_SSH_KEY`, `VPS_HOST`, `VPS_USER`,
`VPS_PORT`, `VPS_APP_PATH`. Notification dùng `TELEGRAM_CHAT_ID` và
`TELEGRAM_TOKEN`.

Authentication dùng Auth0 JWT bắt buộc ở mọi môi trường. Cần cấu hình
`AUTH0_ISSUER_URL`, `AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID` và
`AUTH0_JWKS_URL`. API dùng `sub` của token làm user ID sau khi bỏ tiền tố
`auth0|` để khớp với Account API.

Cloudflare R2 bắt buộc các biến `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET` và `R2_ENDPOINT`.

Các biến môi trường được validate bằng Joi ngay khi ứng dụng khởi động. Không
có giá trị fallback trong code; hãy copy `.env.example` thành `.env` và điền
đầy đủ các giá trị bắt buộc trước khi chạy API hoặc migration.

Mọi response đều có `x-request-id`; request được ghi dưới dạng JSON structured
log để liên kết với hệ thống observability.

Project media hiện hỗ trợ metadata attach/list/update/remove/reorder và thumbnail
selection. Binary upload và processing chạy qua Cloudflare R2; multipart upload
nâng cao sẽ bổ sung sau.

Upload dùng Cloudflare R2 qua S3-compatible API. Upload flow: tạo session →
nhận presigned PUT URL → upload trực tiếp lên R2 → complete → worker tạo
`thumbnail` và `preview` variants.
