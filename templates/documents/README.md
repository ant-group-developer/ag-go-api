# Mẫu chứng từ tạm (Q-R9)

**Đây là bản tạm, chờ nghiệp vụ chuẩn hoá nội dung (Q-R9, Phụ lục B của đặc tả).** Các file do
`yarn documents:templates` sinh từ `src/modules/documents/default-templates.ts`; trong AG Go cài
bằng `POST /api/contract-templates/install-defaults` (chỉ cho loại / mô hình chưa có template).

| File | Loại | Mô hình giá |
|---|---|---|
| `hop-dong-package-tier.docx` | HĐ | `package_tier` (bảng giá CTV) |
| `hop-dong-per-topic.docx` | HĐ | `per_topic` |
| `hop-dong-per-unit.docx` | HĐ | `per_unit` |
| `phu-luc-sua-doi.docx` | Phụ lục sửa đổi | mọi mô hình |
| `bien-ban-nghiem-thu.docx` | BBNT | mọi mô hình (cột số lượng theo mô hình, Phụ lục B.2) |

Nghiệp vụ sửa trong Word rồi upload phiên bản mới ở `/system/contract-templates`. Placeholder dùng
được: `GET /api/contract-templates/placeholders?kind=contract|amendment|acceptance`; placeholder lạ
bị từ chối khi upload.
