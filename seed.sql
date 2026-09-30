-- ====================
-- AG Go seed: roles, permissions, role_permissions
-- ====================
-- Chạy được nhiều lần (idempotent): dựa trên unique key
--   roles(name, application_id), permissions(code, application_id),
--   role_permissions(role_id, permission_id).
-- Yêu cầu: application AG Go đã tồn tại. Nếu không tìm thấy, @app_id = NULL
-- và INSERT sẽ lỗi (application_id NOT NULL) thay vì ghi nhầm sang app khác.
-- Danh sách permission phải khớp với ag-go-api/src/common/auth/permissions.constants.ts
SET @app_id = (
  SELECT id
  FROM applications
  WHERE LOWER(code) IN ('ant-go-v2')
  LIMIT 1
);

-- ====================
-- PERMISSIONS
-- ====================
INSERT INTO permissions
  (id, name, code, description, application_id, is_active, created_at, updated_at, creator_id, modifier_id)
VALUES
  ('9a000001-dbef-11f0-ab89-18c04dc47bd5', '[GO] Project Read', 'go.project.read', 'Read projects, media and previews', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a000002-dbef-11f0-ab89-18c04dc47bd5', '[GO] Project Edit', 'go.project.edit', 'Create and edit projects, media and uploads', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a000003-dbef-11f0-ab89-18c04dc47bd5', '[GO] Project Evaluate', 'go.project.evaluate', 'Evaluate project media', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a000004-dbef-11f0-ab89-18c04dc47bd5', '[GO] Download Original', 'go.project.download_original', 'Download original assets', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a000005-dbef-11f0-ab89-18c04dc47bd5', '[GO] Download Rendered', 'go.project.download_rendered', 'Download rendered assets', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a000006-dbef-11f0-ab89-18c04dc47bd5', '[GO] Folder Manage', 'go.folder.manage', 'Manage folders and folder grants', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a000007-dbef-11f0-ab89-18c04dc47bd5', '[GO] Catalog Manage', 'go.catalog.manage', 'Manage AG Go catalog data', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a000008-dbef-11f0-ab89-18c04dc47bd5', '[GO] Drive Import', 'go.drive.import', 'Connect and import Google Drive snapshots', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a000009-dbef-11f0-ab89-18c04dc47bd5', '[GO] Render Read', 'go.render.read', 'Read render profiles and batches', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a00000a-dbef-11f0-ab89-18c04dc47bd5', '[GO] Render Batch', 'go.render.batch', 'Create and cancel render batches', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a00000b-dbef-11f0-ab89-18c04dc47bd5', '[GO] Statistics Read', 'go.statistics.read', 'Read scoped statistics', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a00000c-dbef-11f0-ab89-18c04dc47bd5', '[GO] Audit Read', 'go.audit.read', 'Read scoped audit logs', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a00000d-dbef-11f0-ab89-18c04dc47bd5', '[GO] Settings Manage', 'go.settings.manage', 'Manage AG Go web branding settings', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a00000e-dbef-11f0-ab89-18c04dc47bd5', '[GO] Logs Read', 'go.logs.read', 'Read scoped audit and operational logs', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a000013-dbef-11f0-ab89-18c04dc47bd5', '[GO] Category Create', 'go.category.create', 'Create catalog categories', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a000014-dbef-11f0-ab89-18c04dc47bd5', '[GO] Tag Create', 'go.tag.create', 'Create catalog tags', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a00000f-dbef-11f0-ab89-18c04dc47bd5', '[GO] Category Edit', 'go.category.edit', 'Edit catalog categories', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a000010-dbef-11f0-ab89-18c04dc47bd5', '[GO] Category Delete', 'go.category.delete', 'Delete unused catalog categories', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a000011-dbef-11f0-ab89-18c04dc47bd5', '[GO] Tag Edit', 'go.tag.edit', 'Edit catalog tags', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a000012-dbef-11f0-ab89-18c04dc47bd5', '[GO] Tag Delete', 'go.tag.delete', 'Delete unused catalog tags', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a000015-dbef-11f0-ab89-18c04dc47bd5', '[GO] Analysis Manage', 'go.analysis.manage', 'Manage media content analysis (backfill, enqueue)', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a000016-dbef-11f0-ab89-18c04dc47bd5', '[GO] Footage Search', 'go.footage.search', 'Search and browse footage segments', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9a000017-dbef-11f0-ab89-18c04dc47bd5', '[GO] Footage Produce', 'go.footage.produce', 'Resolve footage segments for production rendering', @app_id, 1, NOW(), NOW(), NULL, NULL)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  is_active = VALUES(is_active),
  updated_at = NOW();

-- ====================
-- ROLES
-- ====================
INSERT INTO roles
  (id, name, description, application_id, is_active, created_at, updated_at, creator_id, modifier_id)
VALUES
  ('9b000001-dbef-11f0-ab89-18c04dc47bd5', '[GO] Admin', 'Full access to all AG Go features, including settings', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9b000002-dbef-11f0-ab89-18c04dc47bd5', '[GO] Manager', 'Manage projects, folders, catalogs, render and view reports', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9b000003-dbef-11f0-ab89-18c04dc47bd5', '[GO] Editor', 'Create and edit projects, create tags/categories, import from Drive and render', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9b000004-dbef-11f0-ab89-18c04dc47bd5', '[GO] Reviewer', 'View and evaluate project media', @app_id, 1, NOW(), NOW(), NULL, NULL),
  ('9b000005-dbef-11f0-ab89-18c04dc47bd5', '[GO] Viewer', 'View projects and download rendered assets', @app_id, 1, NOW(), NOW(), NULL, NULL)
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  is_active = VALUES(is_active),
  updated_at = NOW();

-- ====================
-- ROLE_PERMISSIONS
-- ====================
-- Lookup theo role name + permission code nên không phụ thuộc vào id cố định ở trên
-- (an toàn khi role/permission đã được tạo trước đó với id khác).
INSERT INTO role_permissions (id, role_id, permission_id, created_at, updated_at, creator_id, modifier_id)
SELECT UUID(), r.id, p.id, NOW(), NOW(), NULL, NULL
FROM (
  -- AG Go Admin: toàn quyền
  SELECT '[GO] Admin' AS role_name, 'go.project.read' AS perm_code
  UNION ALL SELECT '[GO] Admin', 'go.project.edit'
  UNION ALL SELECT '[GO] Admin', 'go.project.evaluate'
  UNION ALL SELECT '[GO] Admin', 'go.project.download_original'
  UNION ALL SELECT '[GO] Admin', 'go.project.download_rendered'
  UNION ALL SELECT '[GO] Admin', 'go.folder.manage'
  UNION ALL SELECT '[GO] Admin', 'go.catalog.manage'
  UNION ALL SELECT '[GO] Admin', 'go.category.create'
  UNION ALL SELECT '[GO] Admin', 'go.tag.create'
  UNION ALL SELECT '[GO] Admin', 'go.category.edit'
  UNION ALL SELECT '[GO] Admin', 'go.category.delete'
  UNION ALL SELECT '[GO] Admin', 'go.tag.edit'
  UNION ALL SELECT '[GO] Admin', 'go.tag.delete'
  UNION ALL SELECT '[GO] Admin', 'go.drive.import'
  UNION ALL SELECT '[GO] Admin', 'go.render.read'
  UNION ALL SELECT '[GO] Admin', 'go.render.batch'
  UNION ALL SELECT '[GO] Admin', 'go.statistics.read'
  UNION ALL SELECT '[GO] Admin', 'go.audit.read'
  UNION ALL SELECT '[GO] Admin', 'go.settings.manage'
  UNION ALL SELECT '[GO] Admin', 'go.logs.read'
  UNION ALL SELECT '[GO] Admin', 'go.analysis.manage'
  UNION ALL SELECT '[GO] Admin', 'go.footage.search'
  UNION ALL SELECT '[GO] Admin', 'go.footage.produce'

  -- AG Go Manager: tất cả trừ settings
  UNION ALL SELECT '[GO] Manager', 'go.project.read'
  UNION ALL SELECT '[GO] Manager', 'go.project.edit'
  UNION ALL SELECT '[GO] Manager', 'go.project.evaluate'
  UNION ALL SELECT '[GO] Manager', 'go.project.download_original'
  UNION ALL SELECT '[GO] Manager', 'go.project.download_rendered'
  UNION ALL SELECT '[GO] Manager', 'go.folder.manage'
  UNION ALL SELECT '[GO] Manager', 'go.catalog.manage'
  UNION ALL SELECT '[GO] Manager', 'go.category.create'
  UNION ALL SELECT '[GO] Manager', 'go.tag.create'
  UNION ALL SELECT '[GO] Manager', 'go.category.edit'
  UNION ALL SELECT '[GO] Manager', 'go.category.delete'
  UNION ALL SELECT '[GO] Manager', 'go.tag.edit'
  UNION ALL SELECT '[GO] Manager', 'go.tag.delete'
  UNION ALL SELECT '[GO] Manager', 'go.drive.import'
  UNION ALL SELECT '[GO] Manager', 'go.render.read'
  UNION ALL SELECT '[GO] Manager', 'go.render.batch'
  UNION ALL SELECT '[GO] Manager', 'go.statistics.read'
  UNION ALL SELECT '[GO] Manager', 'go.audit.read'
  UNION ALL SELECT '[GO] Manager', 'go.logs.read'
  UNION ALL SELECT '[GO] Manager', 'go.analysis.manage'
  UNION ALL SELECT '[GO] Manager', 'go.footage.search'
  UNION ALL SELECT '[GO] Manager', 'go.footage.produce'

  -- AG Go Editor: làm việc với project, Drive, render
  UNION ALL SELECT '[GO] Editor', 'go.project.read'
  UNION ALL SELECT '[GO] Editor', 'go.project.edit'
  UNION ALL SELECT '[GO] Editor', 'go.project.download_original'
  UNION ALL SELECT '[GO] Editor', 'go.project.download_rendered'
  UNION ALL SELECT '[GO] Editor', 'go.folder.manage'
  UNION ALL SELECT '[GO] Editor', 'go.drive.import'
  UNION ALL SELECT '[GO] Editor', 'go.render.read'
  UNION ALL SELECT '[GO] Editor', 'go.render.batch'
  UNION ALL SELECT '[GO] Editor', 'go.category.create'
  UNION ALL SELECT '[GO] Editor', 'go.tag.create'

  -- AG Go Reviewer: xem và đánh giá
  UNION ALL SELECT '[GO] Reviewer', 'go.project.read'
  UNION ALL SELECT '[GO] Reviewer', 'go.project.evaluate'
  UNION ALL SELECT '[GO] Reviewer', 'go.project.download_rendered'
  UNION ALL SELECT '[GO] Reviewer', 'go.render.read'

  -- AG Go Viewer: chỉ xem
  UNION ALL SELECT '[GO] Viewer', 'go.project.read'
  UNION ALL SELECT '[GO] Viewer', 'go.project.download_rendered'
) AS m
JOIN roles r ON r.name = m.role_name AND r.application_id = @app_id
JOIN permissions p ON p.code = m.perm_code AND p.application_id = @app_id
ON DUPLICATE KEY UPDATE
  updated_at = NOW();