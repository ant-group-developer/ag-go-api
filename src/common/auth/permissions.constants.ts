export const GO_PERMISSIONS = {
  PROJECT_READ: 'go.project.read',
  PROJECT_EDIT: 'go.project.edit',
  PROJECT_EVALUATE: 'go.project.evaluate',
  PROJECT_DOWNLOAD_ORIGINAL: 'go.project.download_original',
  PROJECT_DOWNLOAD_RENDERED: 'go.project.download_rendered',
  FOLDER_MANAGE: 'go.folder.manage',
  CATALOG_MANAGE: 'go.catalog.manage',
  DRIVE_IMPORT: 'go.drive.import',
  RENDER_READ: 'go.render.read',
  RENDER_BATCH: 'go.render.batch',
  STATISTICS_READ: 'go.statistics.read',
  AUDIT_READ: 'go.audit.read',
  SETTINGS_MANAGE: 'go.settings.manage',
  LOGS_READ: 'go.logs.read',
} as const;

export type GoPermission = (typeof GO_PERMISSIONS)[keyof typeof GO_PERMISSIONS];
