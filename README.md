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
