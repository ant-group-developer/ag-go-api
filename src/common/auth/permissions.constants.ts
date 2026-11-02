export const GO_PERMISSIONS = {
  PROJECT_READ: 'go.project.read',
  /** Every evaluated project on "Projects" (watermarked unless the grants open its originals). */
  PROJECT_READ_ALL: 'go.project.read_all',
  PROJECT_EDIT: 'go.project.edit',
  PROJECT_EVALUATE: 'go.project.evaluate',
  PROJECT_DOWNLOAD_ORIGINAL: 'go.project.download_original',
  PROJECT_DOWNLOAD_RENDERED: 'go.project.download_rendered',
  FOLDER_MANAGE: 'go.folder.manage',
  FOLDER_CREATE_ROOT: 'go.folder.create_root',
  CATEGORY_ACCESS_MANAGE: 'go.category.access_manage',
  CATALOG_MANAGE: 'go.catalog.manage',
  CATEGORY_CREATE: 'go.category.create',
  CATEGORY_EDIT: 'go.category.edit',
  CATEGORY_DELETE: 'go.category.delete',
  TAG_CREATE: 'go.tag.create',
  TAG_EDIT: 'go.tag.edit',
  TAG_DELETE: 'go.tag.delete',
  DRIVE_IMPORT: 'go.drive.import',
  RENDER_READ: 'go.render.read',
  RENDER_BATCH: 'go.render.batch',
  STATISTICS_READ: 'go.statistics.read',
  AUDIT_READ: 'go.audit.read',
  SETTINGS_MANAGE: 'go.settings.manage',
  LOGS_READ: 'go.logs.read',
  ANALYSIS_MANAGE: 'go.analysis.manage',
  FOOTAGE_SEARCH: 'go.footage.search',
  FOOTAGE_PRODUCE: 'go.footage.produce',
  /** Partners (CTV) of the contracts module; personal data stays masked without PARTNER_PII_READ. */
  PARTNER_READ: 'go.partner.read',
  /** Every partner, not only those one manages (`partners.manager_user_id`). */
  PARTNER_READ_ALL: 'go.partner.read_all',
  PARTNER_MANAGE: 'go.partner.manage',
  /** Full ID card, tax and bank numbers of a partner (`?reveal=pii`); each view is audited. */
  PARTNER_PII_READ: 'go.partner.pii_read',
  CONTRACT_READ: 'go.contract.read',
  /** Every contract, not only those one manages (`contracts.manager_user_id`). */
  CONTRACT_READ_ALL: 'go.contract.read_all',
  /** Create, edit, issue, activate, suspend and terminate contracts and their amendments. */
  CONTRACT_MANAGE: 'go.contract.manage',
  /** Contract / acceptance templates and the company (party A) details. */
  CONTRACT_TEMPLATE_MANAGE: 'go.contract.template_manage',
  /** Create, edit drafts, publish, import / export versions of the CTV rate card (spec 7.2.1). */
  RATE_CARD_MANAGE: 'go.rate_card.manage',
} as const;

export type GoPermission = (typeof GO_PERMISSIONS)[keyof typeof GO_PERMISSIONS];
