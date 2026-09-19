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

Authentication:

- Local development mặc định dùng `AUTH_MODE=dev` và `X-User-Id`.
- Production tự yêu cầu Auth0 JWT nếu không đặt `AUTH_MODE=dev`.
- Khi bật Auth0, cần cấu hình `AUTH0_ISSUER_URL`, `AUTH0_AUDIENCE` và tùy chọn
  `AUTH0_JWKS_URL`, `AUTH0_GROUPS_CLAIM`.

Mọi response đều có `x-request-id`; request được ghi dưới dạng JSON structured
log để liên kết với hệ thống observability.

Project media hiện hỗ trợ metadata attach/list/update/remove/reorder và thumbnail
selection. Binary upload, multipart và R2 worker thuộc Phase 3.
