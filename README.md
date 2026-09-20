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

Local PostgreSQL được publish ở port `55432` qua Docker Compose.

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
